import async, { asyncify } from "async";
import fs from "fs";
import logger from "./logger";
import config from "./config";
import memcached from "./memcached";
import File from "../models/files";

const { encode_version } = config;

export default async function generate_filelist() {
  logger.info("GENERATING PRIMARY FILE LIST");
  // query for any files that have an encode version that doesn't match the current encode version
  // do not hydrate results into models
  // sort by priority, then size, then width
  let filelist = await File.find({
    encode_version: { $ne: encode_version },
    status: "pending",
  })
    .sort({
      "sortFields.priority": 1,
      "sortFields.size": -1,
      "sortFields.width": -1,
    })
    .limit(1000);

  logger.info("FILTERING FILELIST");
  // filter out files that are missing paths
  filelist = filelist.filter((f) => f.path);

  logger.info("REMOVING LOCKED FILES FROM FILELIST");
  // now filter out files that have locks
  await async.eachLimit(
    filelist,
    25,
    asyncify(async (f) => {
      const lock = await memcached.get(`transcode_lock_${f._id}`);

      // find the file in the filelist
      filelist.find((v) => v._id === f._id).locked = !!lock;

      return true;
    })
  );
  logger.info(filelist.filter((f) => f.locked).length, {
    label: "LOCKED FILES FOUND",
  });
  filelist = filelist.filter((f) => !f.locked);

  // remove first item from the list and write the rest to a file
  fs.writeFileSync(
    "./filelist.txt",
    filelist
      .slice(1)
      .map((f) => f.path)
      .join("\n")
  );
  fs.writeFileSync(
    "./output/filelist.json",
    JSON.stringify(
      filelist.slice(1, 1001).map((f) => ({
        path: f.path.split(/\//).pop(),
        size: f.sortFields.size,
        priority: f.sortFields.priority,
        resolution:
          f.probe.streams.find((v) => v.codec_type === "video").width * 0.5625, // use width at 56.25% to calculate resolution
        codec: `${
          f.probe.streams.find((v) => v.codec_type === "video")?.codec_name
        }/${f.probe.streams.find((v) => v.codec_type === "audio")?.codec_name}`,
        encode_version: f.encode_version,
      }))
    )
  );

  // send back full list
  return filelist.map((f) => f.path);
}
