import logger from './logger';
import File from '../models/files';

function default_priority (video) {
  // if the size is less than 2GB in kilobytes, return 99
  if(video.probe.format.size < 2097152){
    return 99;
  }

  return 100;
}

export default async function upsert_video (video) {
  try {
    let { path, record_id } = video;
    path = path.replace(/\n+$/, '');
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

    // get priority from the video object, existing document or default to 100
    const priority =
      video.sortFields?.priority || file?.sortFields?.priority || default_priority(video);

    // merge the sortFields object with the priority
    const sortFields = { ...(video.sortFields || file.sortFields), priority };

    // merge the file object with the video object and override with sortFields
    file = Object.assign(file, video, { sortFields });

    await file.save();
  } catch (e) {
    logger.error(e, { label: 'UPSERT FAILURE' });
  }
}
