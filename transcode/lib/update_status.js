import { writeFile } from 'fs/promises';
import File from '../models/files';
import config from './config';
import { formatSecondsToHHMMSS } from './transcode';
import logger from './logger';
import redisClient from './redis';

const { encode_version } = config;

export async function getReclaimedSpace () {
  let reclaimedSpace = await redisClient.get('transcode_reclaimed_space');

  // Redis returns strings, so parse to number if possible
  if (reclaimedSpace !== null && !Number.isNaN(Number(reclaimedSpace))) {
    return Number(reclaimedSpace);
  }

  logger.debug('Reclaimed space value not found in cache, calculating...');

  // Use MongoDB aggregation to sum reclaimedSpace efficiently
  const aggResult = await File.aggregate([
    { $match: { encode_version } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$reclaimedSpace', 0] } } } }
  ]);
  reclaimedSpace = aggResult[0]?.total || 0;

  // store the reclaimed space in cache for 15 minutes
  await redisClient.set('transcode_reclaimed_space', reclaimedSpace, { EX: 15 * 60 });

  return reclaimedSpace;
}

export default async function update_status ({ startup = false } = {}) {
  try {
    logger.debug('Updating status metrics...');
    const processed_files = await File.countDocuments({ status: 'complete' });
    const total_files = await File.countDocuments();
    const reclaimedSpace = await getReclaimedSpace();

    const data = {
      processed_files,
      total_files,
      unprocessed_files: total_files - processed_files,
      library_coverage: processed_files / total_files * 100,
      reclaimedSpace
    };

    logger.debug('Status data complete');

    // Always set serviceStartTime to now on startup
    if (startup) {
      global.serviceStartTime = Date.now();
      global.processedOnStart = data.processed_files;
      global.processed_files_delta = 0;
    }

    data.processed_files_delta = global.processed_files_delta || 0;
    data.service_up_time = formatSecondsToHHMMSS(
      Math.floor((Date.now() - global.serviceStartTime) / 1000)
    );
    data.serviceStartTime = global.serviceStartTime;

    await writeFile('/usr/app/output/status.json', JSON.stringify(data));
  } catch (e) {
    logger.error(e, { label: 'UPDATE STATUS ERROR' });
  }
}
