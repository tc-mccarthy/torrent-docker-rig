/**
 * @file exec_promise.js
 * @description
 * A safe, memory-bounded helper for running shell commands.
 *
 * Why this exists:
 * - `child_process.exec()` buffers the *entire* stdout/stderr output in memory.
 * - In a transcoding environment, verbose commands (or accidental debug flags)
 *   can produce huge output quickly and force Node/V8 to expand the heap.
 * - Once V8 grows, it often does not return memory to the OS promptly, which
 *   reduces headroom for ffmpeg and can trigger OOM kills (exit code 137).
 *
 * This implementation uses `spawn()` with `shell: true` to preserve the
 * convenience of passing a single command string, while *streaming* output.
 *
 * It keeps only the last N bytes of stdout/stderr in a ring buffer so callers
 * still get useful diagnostics on failure without unbounded memory growth.
 */

import { spawn } from 'child_process';
import logger from './logger';

/**
 * A tiny ring buffer for accumulating only the last N bytes of text.
 *
 * @param {number} maxBytes
 */
function createByteRingBuffer (maxBytes) {
  const chunks = [];
  let total = 0;

  /**
   * Appends data to the buffer, dropping oldest chunks until we are under cap.
   * @param {Buffer|string} data
   */
  function push (data) {
    if (!data) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    chunks.push(buf);
    total += buf.length;
    while (total > maxBytes && chunks.length > 0) {
      const removed = chunks.shift();
      total -= removed.length;
    }
  }

  /** @returns {string} */
  function toString () {
    return Buffer.concat(chunks).toString('utf8');
  }

  return { push, toString };
}

/**
 * Runs a shell command with streamed output and bounded in-memory buffering.
 *
 * @param {string} cmd - The command to execute (single string, run via shell)
 * @param {Object} [options]
 * @param {number} [options.captureBytes=1048576] - Max bytes to keep for stdout and stderr (each)
 * @param {boolean} [options.logStdout=false] - Whether to log stdout chunks at debug level
 * @param {boolean} [options.logStderr=false] - Whether to log stderr chunks at debug level
 * @param {number} [options.timeoutMs=0] - If >0, kill the process after this many ms
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export default function exec_promise (cmd, options = {}) {
  const {
    captureBytes = 1024 * 1024, // 1MB per stream (stdout/stderr)
    logStdout = false,
    logStderr = false,
    timeoutMs = 0
  } = options;

  return new Promise((resolve, reject) => {
    logger.debug(cmd, { label: 'Shell command' });

    // Use shell mode to preserve existing usage patterns.
    const child = spawn(cmd, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const outBuf = createByteRingBuffer(captureBytes);
    const errBuf = createByteRingBuffer(captureBytes);

    let timeout;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        // SIGKILL is intentional: if we time out, we want this to stop.
        try { child.kill('SIGKILL'); } catch (e) {
          logger.error('Failed to kill timed-out process', { error: e, cmd });
        }
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      outBuf.push(chunk);
      if (logStdout) logger.debug(chunk.toString('utf8'), { label: 'Shell stdout' });
    });

    child.stderr.on('data', (chunk) => {
      errBuf.push(chunk);
      if (logStderr) logger.debug(chunk.toString('utf8'), { label: 'Shell stderr' });
    });

    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);

      const stdout = outBuf.toString();
      const stderr = errBuf.toString();

      // Non-zero exit codes should reject so callers can handle failures.
      if (code !== 0) {
        const error = new Error(`Command failed (code=${code}, signal=${signal ?? 'none'}): ${cmd}`);
        // Attach the last captured output for debugging.
        error.code = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }

      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}
