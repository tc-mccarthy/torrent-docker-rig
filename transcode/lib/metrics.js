// File system, process execution, and system metrics imports
import fs from 'fs';
import { exec } from 'child_process';
import si from 'systeminformation';
import config from './config';
import { getCpuLoadPercentage } from './getCpuLoadPercentage';

// Extract path configuration utility from config
const { get_paths } = config;
// List of paths to monitor for disk space
const PATHS = get_paths(config);

/**
 * Poll disk space usage for configured paths and persist results.
 *
 * This function executes 'df -h' to get disk usage for all mounted filesystems,
 * parses the output, filters for configured paths, and writes the results to disk.
 * It also schedules itself to run every 10 seconds.
 *
 * @returns {Promise<Array<Object>>} Resolves with array of disk usage objects.
 */
export function get_disk_space () {
  // Clear any existing disk space polling timeout to avoid duplicate intervals
  clearTimeout(global.disk_space_timeout);
  return new Promise((resolve, reject) => {
    // Execute 'df -h' to get human-readable disk usage for all mounted filesystems
    exec('df -h', (err, stdout, stderr) => {
      if (err) {
        // If the command fails, reject the promise
        reject(err);
      } else {
        // Parse the output into rows and columns
        let rows = stdout.split(/\n+/).map((row) => row.split(/\s+/));
        // Remove header row and map each row to an object keyed by header
        rows = rows
          .splice(1)
          .map((row) => {
            const obj = {};
            rows[0].forEach((value, idx) => {
              // Normalize header names for object keys
              obj[value.toLowerCase().replace(/[^A-Za-z0-9]+/i, '')] = row[idx];
            });
            return obj;
          })
          // Filter only the mounts we care about (from PATHS)
          .filter(
            (obj) =>
              PATHS.findIndex((path) => {
                if (obj.mounted) {
                  return path.indexOf(obj.mounted) > -1;
                }
                return false;
              }) > -1
          )
          // Add percent used and threshold status for each mount
          .map((obj) => {
            obj.percent_used = parseInt(obj.use.replace('%', ''), 10);
            obj.above_threshold = obj.percent_used > 85;
            return obj;
          });
        // Persist disk usage data to disk for external monitoring
        fs.writeFileSync('/usr/app/output/disk.json', JSON.stringify(rows));
        // Schedule next disk space poll in 10 seconds
        global.disk_space_timeout = setTimeout(() => {
          get_disk_space();
        }, 10 * 1000);
        // Resolve with the parsed disk usage data
        resolve(rows);
      }
    });
  });
}

/**
 * Poll system memory and CPU utilization and persist results.
 *
 * This function uses systeminformation to gather memory and CPU usage,
 * writes the results to disk, and schedules itself to run every 10 seconds.
 *
 * CPU utilization is calculated using load-to-core ratio, allowing values to
 * exceed 100% to reflect true processing pressure.
 */
export async function get_utilization () {
  // Clear any existing utilization polling timeout to avoid duplicate intervals
  clearTimeout(global.utilization_timeout);

  try {
    // Gather memory and CPU usage concurrently
    const [mem] = await Promise.all([si.mem()]);
    const { loadPercent: cpuLoadPercent } = await getCpuLoadPercentage();

    // Calculate memory usage percentage
    const memoryUsedPercent = 100 - Math.round(mem.available / mem.total * 100);

    // Compose utilization data
    const data = {
      memory: memoryUsedPercent,
      cpu: cpuLoadPercent,
      last_updated: new Date()
    };

    // Write data to disk for external monitoring tools
    fs.writeFileSync('/usr/app/output/utilization.json', JSON.stringify(data));
  } catch (err) {
    console.error('[get_utilization] Failed to fetch system info:', err);
  }

  // Schedule next poll after 10 seconds
  global.utilization_timeout = setTimeout(() => {
    get_utilization();
  }, 10 * 1000);
}
