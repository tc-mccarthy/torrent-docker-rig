import { exec } from 'child_process';
import logger from './logger';

export default function exec_promise (cmd) {
  return new Promise((resolve, reject) => {
    logger.debug(cmd, { label: 'Shell command' });
    exec(cmd, { maxBuffer: 1024 * 1024 * 500 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}
