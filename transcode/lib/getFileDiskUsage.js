// diskUtilization.js
import { exec } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Calculates the percentage of disk space used on the volume
 * where the specified file or directory resides.
 *
 * This function uses the Unix `df` command with POSIX output and
 * kilobyte units to ensure consistent, script-friendly formatting.
 *
 * @param {string} filePath - The absolute or relative path to a file or directory.
 * @returns {Promise<number>} - A Promise that resolves to the disk utilization percentage (e.g., 74.3).
 * @throws {Error} If the `df` output is unexpected or an error occurs during execution.
 */
export default async function getDiskUtilization (filePath) {
  try {
    // Convert to an absolute path to ensure df behaves correctly
    const resolvedPath = resolvePath(filePath);

    // Run `df -Pk` to get POSIX-compliant output in kilobytes for the specified path
    const { stdout } = await execAsync(`df -Pk "${resolvedPath}"`);

    // Split output into lines and discard the header
    const lines = stdout.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('Unexpected output from df command.');
    }

    // Parse the line with usage data (2nd line)
    const columns = lines[1].trim().split(/\s+/);
    if (columns.length < 5) {
      throw new Error('Could not parse df output columns.');
    }

    // Extract used and available blocks (in kilobytes)
    const usedKB = parseInt(columns[2], 10);
    const availableKB = parseInt(columns[3], 10);

    if (Number.isNaN(usedKB) || Number.isNaN(availableKB)) {
      throw new Error('Invalid numeric values in df output.');
    }

    // Compute utilization percentage
    const utilization = (usedKB / (usedKB + availableKB)) * 100;
    return parseFloat(utilization.toFixed(1));
  } catch (err) {
    // Rethrow with context for clarity
    throw new Error(`Failed to calculate disk utilization: ${err.message}`);
  }
}
