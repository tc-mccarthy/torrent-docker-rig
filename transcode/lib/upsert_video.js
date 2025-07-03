import logger from './logger';
import File from '../models/files';
import roundToNearestQuarter from './round-to-nearest-quarter';

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
      return 97;
    }

    // if the size is less than 500 MB in kilobytes
    if (convertKilobytes(video.probe.format.size, 'MB') <= 500) {
      return 98;
    }

    // if the size is less than 1GB in kilobytes
    if (convertKilobytes(video.probe.format.size, 'GB') <= 1) {
    // if the video is HEVC encoded, return 98
      if (video.probe.streams.find((s) => s.codec_type === 'video')?.codec_name === 'hevc') {
        return 98;
      }

      return 99;
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
    const priority = Math.min(
      video.sortFields?.priority ||
        file?.sortFields?.priority ||
        default_priority(video),
      default_priority(video)
    );

    // merge the sortFields object with the priority
    const sortFields = { ...(video.sortFields || file.sortFields), priority };
    const computeScore = roundToNearestQuarter(sortFields.width / 3840);

    // merge the file object with the video object and override with sortFields
    file = Object.assign(file, video, { sortFields, computeScore });

    await file.saveDebounce();
  } catch (e) {
    logger.error(e, { label: 'UPSERT FAILURE' });
  }
}
