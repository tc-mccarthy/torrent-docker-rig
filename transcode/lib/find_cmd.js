import { spawn } from 'child_process';
import logger from './logger';

/**
 * @file find_cmd.js
 *
 * Memory-safe wrapper around GNU `find` that streams results instead of buffering.
 *
 * Why:
 * - `find -print0` can output extremely large result sets.
 * - Buffering stdout into a giant JS string (or splitting into a huge array) can blow the V8 heap
 *   under tight limits (e.g., 4GB).
 *
 * This module parses NUL-delimited paths incrementally and optionally calls `onPath` for each match.
 * It returns a small summary suitable for logging and error persistence.
 */

/**
 * @typedef {Object} FindSummary
 * @property {number} count Total number of paths emitted.
 * @property {string[]} sampleHead First few paths seen (bounded).
 * @property {string[]} sampleTail Last few paths seen (bounded).
 * @property {string} probeSince Cutoff timestamp used for -newermt/-newerct.
 * @property {string[]} paths Root search paths.
 * @property {string[]} fileExts File extensions matched.
 */

/**
 * Stream a `find` query and parse NUL-delimited results.
 *
 * @param {string[]} paths Directories to search recursively.
 * @param {string[]} fileExts Extensions without dot (e.g. ['mkv','mp4']).
 * @param {string} probeSince Timestamp string understood by GNU find for -newermt/-newerct.
 * @param {Object} [opts]
 * @param {(path: string) => (void|Promise<void>)} [opts.onPath] Called per matched path.
 * @param {AbortSignal} [opts.signal] Optional abort signal.
 * @param {number} [opts.sampleSize=10] Head/tail sample size retained for debug summaries.
 * @returns {Promise<FindSummary>} Small summary safe to log/persist.
 */
export default function findCMD (paths, fileExts, probeSince, opts = {}) {
  const { onPath, signal, sampleSize = 10 } = opts;

  // Build ( -iname "*.mkv" -o -iname "*.mp4" ... )
  const extExpr = [];
  for (let i = 0; i < fileExts.length; i += 1) {
    const ext = fileExts[i];
    extExpr.push('-iname', `*.${ext}`);
    if (i !== fileExts.length - 1) extExpr.push('-o');
  }

  // NOTE:
  // -newerct requires GNU find (works on most modern Linux distros).
  // This matches your existing behavior; if you ever need portability, we can feature-detect.
  const findArgs = [
    ...paths,
    '(',
    ...extExpr,
    ')',
    '-a',
    '(',
    '-newermt',
    probeSince,
    '-o',
    '-newerct',
    probeSince,
    ')',
    '-print0'
  ];

  logger.debug('Executing find (streaming)', { paths, fileExts, probeSince });

  return new Promise((resolve, reject) => {
    const child = spawn('find', findArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (signal) {
      if (signal.aborted) {
        try { child.kill('SIGKILL'); } catch (e) { logger.warn('Failed to kill child process', { error: e }); }
        return reject(new Error('findCMD aborted before start'));
      }
      signal.addEventListener('abort', () => {
        try { child.kill('SIGKILL'); } catch (e) { logger.warn('Failed to kill child process', { error: e }); }
      }, { once: true });
    }

    let buffer = Buffer.alloc(0);
    let count = 0;

    /** @type {string[]} */
    const sampleHead = [];
    /** @type {string[]} */
    const sampleTail = [];

    let stderrBuf = '';
    const MAX_STDERR = 64 * 1024;

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderrBuf += s;
      if (stderrBuf.length > MAX_STDERR) {
        stderrBuf = stderrBuf.slice(stderrBuf.length - MAX_STDERR);
      }
    });

    child.stdout.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      let idx;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buffer.indexOf(0)) !== -1) {
        const record = buffer.subarray(0, idx);
        buffer = buffer.subarray(idx + 1);

        if (!record.length) {
          // Instead of continue, just skip to next iteration
          // (no-op)
        } else {
          const p = record.toString('utf8');
          count += 1;

          if (sampleHead.length < sampleSize) sampleHead.push(p);
          else {
            sampleTail.push(p);
            if (sampleTail.length > sampleSize) sampleTail.shift();
          }

          if (onPath) await onPath(p);
        }

        const p = record.toString('utf8');
        count += 1;

        if (sampleHead.length < sampleSize) sampleHead.push(p);
        else {
          sampleTail.push(p);
          if (sampleTail.length > sampleSize) sampleTail.shift();
        }

        if (onPath) {
          // Preserve backpressure: if onPath is heavy, it should enqueue work quickly and return.

          await onPath(p);
        }
      }
    });

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`find exited with code ${code}. stderr(last64kb)=${stderrBuf}`));
      }

      // find -print0 should terminate records with NUL; keep summary accurate if not.
      if (buffer.length) {
        const p = buffer.toString('utf8');
        count += 1;
        if (sampleHead.length < sampleSize) sampleHead.push(p);
        else {
          sampleTail.push(p);
          if (sampleTail.length > sampleSize) sampleTail.shift();
        }
      }

      resolve({
        count,
        sampleHead,
        sampleTail,
        probeSince,
        paths,
        fileExts
      });
    });
  });
}
