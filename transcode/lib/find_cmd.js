
import { spawn } from 'child_process';
import logger from './logger';

const { resolve, reject } = Promise;

/**
 * Asynchronously runs a find command to locate files matching criteria.
 * Uses spawn to avoid shell escaping issues and to provide robust argument handling.
 *
 * @param {string[]} paths - Array of directory paths to search. Each path is searched recursively.
 * @param {string[]} fileExts - Array of file extensions (without dot) to match (e.g., ['mkv', 'mp4']).
 * @param {string} probeSince - Date string (MM/DD/YYYY HH:mm:ss) for mtime/ctime/atime cutoff. Only files newer than this are included.
 * @returns {Promise<string>} Resolves with stdout (file list, null-separated) on success, rejects with error on failure.
 *
 * Example usage:
 *   const files = await findCMD(['/media', '/other'], ['mkv', 'mp4'], '12/18/2025 00:00:00');
 */
export default async function findCMD (paths, fileExts, probeSince) {
  // Build the argument array for the find command.
  // Each line is commented for clarity and maintainability.
  const findArgs = [
    ...paths, // Directories to search recursively

    // Start group for file extension matching
    '(', // Open group for OR-ing file extension matches

    // Add -iname "*.ext" for each extension, joined by -o (OR)
    ...fileExts.flatMap((ext, i) => (
      i === 0
        ? ['-iname', `*.${ext}`] // First extension: just -iname
        : ['-o', '-iname', `*.${ext}`] // Subsequent: -o -iname
    )),

    ')', // Close group for file extension matching

    // Exclude files ending with .tc.mkv (transcode output files)
    '-not', '(', '-iname', '*.tc.mkv', ')',

    // Start group for time-based filtering (OR)
    '(',
    // Modified time (mtime) newer than probeSince
    '-newermt', probeSince,
    // OR inode change time (ctime) newer than probeSince
    '-o', '-newerct', probeSince,
    ')',

    // Output null-separated file list for robust parsing
    '-print0'
  ];

  // Log the executed find command for debugging and traceability
  logger.info(
      `Executing find command: find ${findArgs.map((arg) => `'${arg}'`).join(' ')}`
  );

  // Spawn the find process with the constructed arguments
  const find = spawn('find', findArgs);
  let stdout = '';
  let stderr = '';

  // Collect stdout (file list)
  find.stdout.on('data', (data) => { stdout += data; });
  // Collect stderr (errors/warnings)
  find.stderr.on('data', (data) => { stderr += data; });

  // Handle process exit
  find.on('close', (code) => {
    if (code === 0) {
      // Success: resolve with file list
      logger.info('Find command completed successfully');
      resolve(stdout);
    } else {
      // Failure: reject with error and stderr
      logger.error(`Find command failed with code ${code}`, { stderr });
      reject(new Error(`find exited with code ${code}: ${stderr}`));
    }
  });

  // Handle process errors (e.g., spawn failure)
  find.on('error', (err) => reject(err));
}
