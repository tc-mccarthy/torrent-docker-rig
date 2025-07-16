import { writeFile } from 'fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import File from '../models/files';
import config from './config';
import { formatSecondsToHHMMSS } from './transcode';
import logger from './logger';

const { encode_version } = config;

export default async function update_status () {
  try {
    logger.info('Updating status metrics...');
    const data = {
      processed_files: await File.countDocuments({ status: 'complete' }),
      total_files: await File.countDocuments(),
      unprocessed_files: await File.countDocuments({
        encode_version: { $ne: encode_version }
      }),
      library_coverage:
      ((await File.countDocuments({ encode_version })) /
        (await File.countDocuments())) *
      100,
      reclaimedSpace: (await File.find({ encode_version }).lean()).reduce((total, file) => total + (file.reclaimedSpace || 0), 0)
    };

    logger.info('Status data complete');
    
    if (typeof global.processedOnStart === 'undefined') {
      global.processedOnStart = data.processed_files;
      global.serviceStartTime = Date.now();
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
  } finally {
    // Ensure the function runs again after a delay
    logger.info('Requeuing status metrics...');
    delay(5000); // Wait for 5 seconds before the next run
    update_status();
  }
}
