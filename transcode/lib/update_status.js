import fs from 'fs';
import File from '../models/files';
import config from './config';

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

  fs.writeFileSync('/usr/app/output/status.json', JSON.stringify(data));
}
