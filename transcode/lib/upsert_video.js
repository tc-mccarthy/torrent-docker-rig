import logger from "./logger";
import File from "../models/files";

export function default_priority(video) {
  // if the size is more than 20GB in kilobytes
  if (video.probe.format.size >= 20971520) {
    return 97;
  }
  
  // if the size is less than 1GB in kilobytes
  if (video.probe.format.size <= 524288) {
    return 98;
  }
  
  // if the size is less than 1GB in kilobytes
  if (video.probe.format.size <= 1048576) {
    return 99;
  }

  return 100;
}

export default async function upsert_video(video) {
  try {
    let { path, record_id } = video;
    path = path.replace(/\n+$/, "");
    let file;

    if (record_id) {
      file = await File.findOne({ _id: record_id });
    }

    if (!file) {
      file = await File.findOne({ path });
    }

    if (!file) {
      file = new File(video);
    }

    // get the highest priority from the video or file sortfields and default priority
    const priority = Math.min(
      video.sortFields?.priority ||
        file?.sortFields?.priority ||
        default_priority(video),
      default_priority(video)
    );

    // merge the sortFields object with the priority
    const sortFields = { ...(video.sortFields || file.sortFields), priority };

    // merge the file object with the video object and override with sortFields
    file = Object.assign(file, video, { sortFields });

    await file.save();
  } catch (e) {
    logger.error(e, { label: "UPSERT FAILURE" });
  }
}
