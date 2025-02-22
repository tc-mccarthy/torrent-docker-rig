import fs from 'fs';
import { exec } from 'child_process';
import File from '../models/files';
import exec_promise from './exec_promise';
import config from './config';

export function escape_file_path (file) {
  return file.replace(/(['])/g, "'\\''").replace(/\n+$/, '');
}

export async function trash (file) {
  if (!file) {
    return true;
  }

  // update the file's status to deleted
  await File.updateOne({ path: file }, { $set: { status: 'deleted' } });

  file = escape_file_path(file.replace(/\/$/g, '')).trim();

  if (fs.existsSync(file)) {
    exec(`rm '${file}'`, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        return Promise.reject(error);
      }
      return Promise.resolve();
    });
  } else {
    return Promise.resolve();
  }
}

export async function create_scratch_disks () {
  await exec_promise(
    `mkdir -p ${config.sources
      .map((p) => `"${p.path}" "${p.scratch}"`)
      .join(' ')}`
  );
}
