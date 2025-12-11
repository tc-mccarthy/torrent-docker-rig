import logger from './logger';
import File from '../models/files';
import calculateComputeScore from './calculateComputeScore';
import { computeEffectiveBitrate } from './calculate_effective_bitrate';

/**
 * Converts a value in kilobytes (KB) to another byte unit.
 * Used for file size calculations and priority logic.
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
    GB: 1 / 1024 ** 2, // 1 KB = 1/1,048,576 GB
    TB: 1 / 1024 ** 3, // 1 KB = 1/1,073,741,824 TB
    PB: 1 / 1024 ** 4 // 1 KB = 1/1,099,511,627,776 PB
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

/**
 * Determines the default processing priority for a video.
 *
 * Priority logic:
 *   - If the file's volume is over 90% utilized, set priority to 97 (high urgency for freeing space)
 *   - If the video is less than or equal to 1GB and is HEVC encoded, set priority to 90 (quick remux)
 *   - If the video has a 'priority-transcode' tag, set priority to 91
 *   - If the video's effective bitrate exceeds 60Mbps, set priority to 92 (on-demand transcode for Plex)
 *   - Otherwise, default to 100 (normal priority)
 *
 * @async
 * @function default_priority
 * @param {object} video - The video object, including probe, path, and indexerData
 * @returns {Promise<number>} - The computed priority
 */
export async function default_priority (video) {
  try {
    // --- Priority: Quick remux for small HEVC files ---
    if (convertKilobytes(video.probe.format.size, 'GB') <= 1) {
      // If the video is HEVC encoded, set a slightly higher priority for quick remux
      if (
        video.probe.streams.find((s) => s.codec_type === 'video')
          ?.codec_name === 'hevc'
      ) {
        return 90; // Give priority to videos that can be remuxed quickly (small HEVC)
      }
    }

    // --- Priority: Tag-based override for urgent transcodes ---
    if (video.indexerData?.tags?.includes('priority-transcode')) {
      // If the video has a priority-transcode tag, set high priority
      return 91;
    }

    // --- Default case: normal priority ---
    return 100; // No special conditions met, normal priority
  } catch (e) {
    // Log any errors and fall back to default priority
    logger.error(e, { label: 'DEFAULT PRIORITY ERROR' });
    return 100; // Fallback to normal priority on error
  }
}

/**
 * Upserts (inserts or updates) a video record in the database.
 *
 * - Attempts to find an existing file by record_id or path.
 * - If not found, creates a new File instance.
 * - Preserves any existing indexerData before updating.
 * - Computes and assigns effectiveBitrate for playback/transcode logic.
 * - Determines the appropriate priority for processing, preserving any preset priority < 90.
 * - Merges sortFields and updates computeScore.
 * - Saves the file with debounce to avoid rapid duplicate writes.
 *
 * @async
 * @function upsert_video
 * @param {object} video - The video object to upsert (probe, path, indexerData, etc.)
 * @returns {Promise<void>} Resolves when upsert completes.
 */
export default async function upsert_video (video) {
  try {
    let { path, record_id } = video;
    // Remove any trailing newlines from the path (defensive)
    path = path.replace(/\n+$/, '');
    let file;

    // Try to find the file by record_id first (most reliable unique identifier)
    if (record_id) {
      file = await File.findOne({ _id: record_id });
    }

    // If not found, try to find by path (fallback to path uniqueness)
    if (!file) {
      file = await File.findOne({ path });
    }

    // If still not found, create a new File instance (new file in DB)
    if (!file) {
      file = new File(video);
    }

    // --- Preserve any existing indexerData before assessing priority ---
    if (file.indexerData && !video.indexerData) {
      video.indexerData = file.indexerData;
    }

    // --- Compute and assign effective bitrate for playback/transcode logic ---
    video.effectiveBitrate = computeEffectiveBitrate(video.probe);

    // --- Priority logic ---
    // If a priority is already set on the video or file and it's less than 90, preserve it.
    // Otherwise, use the computed default priority.
    const preset_priority =
      video.sortFields?.priority || file?.sortFields?.priority;
    let priority = await default_priority(video);
    if (preset_priority && preset_priority < 90) {
      priority = preset_priority;
    }

    // Merge the sortFields object with the new priority
    const sortFields = { ...(video.sortFields || file.sortFields), priority };

    // Merge the file object with the video object and override with sortFields
    file = Object.assign(file, video, { sortFields });

    // Calculate the compute score for this file (used for scheduling/transcode queue)
    file.computeScore = calculateComputeScore(file);

    // Save the file, debounced to avoid rapid duplicate writes
    await file.saveDebounce();
  } catch (e) {
    // Log any errors that occur during upsert
    logger.error(e, { label: 'UPSERT FAILURE' });
  }
}
