import logger from './logger';
import File from '../models/files';

/**
 * Converts a value in kilobytes (KB) to another byte unit.
 *
 * @param {number} valueInKB - The value in kilobytes to convert.
 * @param {string} targetUnit - The unit to convert to. Supported values: B, KB, MB, GB, TB, PB.
 * @returns {number} - The converted value in the target unit.
 */
function convertKilobytes (valueInKB, targetUnit) {
  // Define conversion factors relative to 1 KB
  const units = {
    B: 1024, // 1 KB = 1024 Bytes
    KB: 1, // 1 KB = 1 KB
    MB: 1 / 1024, // 1 KB = 1/1024 MB
    GB: 1 / (1024 ** 2), // 1 KB = 1/1,048,576 GB
    TB: 1 / (1024 ** 3), // 1 KB = 1/1,073,741,824 TB
    PB: 1 / (1024 ** 4) // 1 KB = 1/1,099,511,627,776 PB
  };

  // Normalize the target unit to uppercase for consistent comparison
  const normalizedUnit = targetUnit.toUpperCase();

  // Check if the target unit is supported
  if (!units[normalizedUnit]) {
    throw new Error(`Unsupported unit: ${targetUnit}`);
  }

  // Perform the conversion using the appropriate factor
  return valueInKB * units[normalizedUnit];
}

export function default_priority (video) {
  try {
    // if the size is more than 20GB in kilobytes
    if (convertKilobytes(video.probe.format.size, 'GB') >= 20) {
      return 96;
    }

    // if the size is less than 1GB in kilobytes
    if (convertKilobytes(video.probe.format.size, 'GB') <= 1) {
    // if the video is HEVC encoded, return 97 because we're just going to copy the video stream
      if (video.probe.streams.find((s) => s.codec_type === 'video')?.codec_name === 'hevc') {
        return 97;
      }
    }

    // default priority for other videos
    return 100;
  } catch (e) {
    logger.error(e, { label: 'DEFAULT PRIORITY ERROR' });
    return 100;
  }
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

    // get the highest priority from the video or file sortfields and default priority

    // if the priority is already set on the video or the file, and it's less than 90, preserve it, otherwise set it to the default priority
    const preset_priority = video.sortFields?.priority || file?.sortFields?.priority;

    let priority = default_priority(video);

    if (preset_priority && preset_priority < 90) {
      // if the preset priority is less than 90, use it
      priority = preset_priority;
    }

    // merge the sortFields object with the priority
    const sortFields = { ...(video.sortFields || file.sortFields), priority };

    // merge the file object with the video object and override with sortFields
    file = Object.assign(file, video, { sortFields });

    await file.saveDebounce();
  } catch (e) {
    logger.error(e, { label: 'UPSERT FAILURE' });
  }
}
