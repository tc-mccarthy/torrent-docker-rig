import fs from 'fs';
import File from '../models/files';
import config from './config';
import { formatSecondsToHHMMSS } from './transcode';

const { encode_version } = config;

export default async function update_status () {
  const data = {
    processed_files: await File.countDocuments({ encode_version }),
    total_files: await File.countDocuments(),
    unprocessed_files: await File.countDocuments({
      encode_version: { $ne: encode_version }
    }),
    library_coverage:
      ((await File.countDocuments({ encode_version })) /
        (await File.countDocuments())) *
      100
  };

  if(!global.processedOnStart) {
    global.processedOnStart = data.processed_files;
    global.serviceStartTime = Date.now();
  }

  data.processed_files_delta = data.processed_files - global.processedOnStart;
  data.service_up_time = formatSecondsToHHMMSS(
    Math.floor((Date.now() - global.serviceStartTime) / 1000)
  );

  fs.writeFileSync('/usr/app/output/status.json', JSON.stringify(data));
}
