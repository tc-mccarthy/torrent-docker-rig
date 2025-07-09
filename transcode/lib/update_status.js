import fs from 'fs';
import File from '../models/files';
import config from './config';
import { formatSecondsToHHMMSS } from './transcode';

const { encode_version } = config;

export default async function update_status () {
  clearTimeout(global.updateStatusTimeout);
  const data = {
    processed_files: await File.countDocuments({ status: 'complete' }),
    total_files: await File.countDocuments(),
    unprocessed_files: await File.countDocuments({
      encode_version: { $ne: encode_version }
    }),
    library_coverage:
      ((await File.countDocuments({ encode_version })) /
        (await File.countDocuments())) *
      100
  };

  if (typeof global.processedOnStart === 'undefined') {
    global.processedOnStart = data.processed_files;
    global.serviceStartTime = Date.now();
  }

  data.processed_files_delta = Math.max(data.processed_files - global.processedOnStart, 0);
  data.service_up_time = formatSecondsToHHMMSS(
    Math.floor((Date.now() - global.serviceStartTime) / 1000)
  );
  data.serviceStartTime = global.serviceStartTime;

  fs.writeFileSync('/usr/app/output/status.json', JSON.stringify(data));

  global.updateStatusTimeout = setTimeout(update_status, 1000 * 5);
}
