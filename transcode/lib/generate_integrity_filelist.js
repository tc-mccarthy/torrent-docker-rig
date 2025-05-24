import async, { asyncify } from "async";
import logger from "./logger";
import memcached from "./memcached";
import File from "../models/files";

export default async function generate_integrity_filelist() {
  logger.info("GENERATING PRIMARY FILE LIST");
  // query for any files that have not been processed yet AND that have not yet had their integrity checked
  // do not hydrate results into models
  // sort by priority, then size, then width
  let filelist = await File.find({
    status: "pending",
    $or: [
      { integrityCheck: { $exists: false } },
      { integrityCheck: { $ne: true } },
    ]
  })
    .sort({
      "sortFields.priority": 1,
      "sortFields.size": 1,
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
    asyncify(async (video_record) => {
      const lock = await memcached.get(`integrity_lock_${video_record._id}`);

      // find the file in the filelist
      const idx = filelist.findIndex((v) => v._id === video_record._id);

      filelist[idx].locked = !!lock;

      return true;
    })
  );
  logger.info(filelist.filter((f) => f.locked).length, {
    label: "LOCKED INTEGRITY FILES FOUND",
  });
  filelist = filelist.filter((f) => !f.locked);

  logger.info(filelist, {
    label: "INTEGRITY CHECK FILELIST",
  });

  // send back full list
  return filelist.map((f) => f.path);
}
