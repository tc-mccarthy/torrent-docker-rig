import { exec } from 'child_process';
import logger from './logger';

/**
 * @file exec_promise.js
 *
 * Promise-based wrapper around `child_process.exec`.
 *
 * IMPORTANT:
 * - `exec()` buffers stdout/stderr in memory. This is dangerous for commands that can emit a lot of output.
 * - We cap maxBuffer aggressively to prevent Node heap blow-ups.
 *
 * For large-output commands, prefer streaming APIs (e.g., spawn + incremental parsing).
 *
 * @param {string} cmd Shell command to execute.
 * @param {Object} [opts]
 * @param {number} [opts.maxBufferBytes=10485760] Max bytes buffered for stdout/stderr (default 10MB).
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export default function exec_promise (cmd, opts = {}) {
  const maxBufferBytes = Number.isFinite(opts.maxBufferBytes) ? opts.maxBufferBytes : 10 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    logger.debug(cmd, { label: 'Shell command' });

    exec(cmd, { maxBuffer: maxBufferBytes }, (error, stdout, stderr) => {
      if (error) {
        // Preserve stdout/stderr for debugging, but they are bounded by maxBufferBytes.
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}
