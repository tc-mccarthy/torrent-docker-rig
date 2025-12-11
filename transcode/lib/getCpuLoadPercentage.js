import fs from 'fs';
import si from 'systeminformation';

/**
 * Returns a system-wide CPU load percentage based on 1-minute load average.
 * This uses /proc/loadavg for true system load and adjusts for core count.
 *
 * @returns {Promise<number>} CPU load percentage (can exceed 100)
 */
export async function getCpuLoadPercentage () {
  try {
    // Read true 1-minute load average from /proc/loadavg
    const contents = fs.readFileSync('/proc/loadavg', 'utf-8');
    const [oneMinLoadAvg] = contents.trim().split(' ');
    const loadAvg = parseFloat(oneMinLoadAvg);

    // Get core count from systeminformation
    const { cpus } = await si.currentLoad();
    const coreCount = cpus.length;

    // Calculate load percentage (can exceed 100%)
    return { loadPercent: Math.round((loadAvg / coreCount) * 100), loadAvg, coreCount, loadRatio: loadAvg / coreCount };
  } catch (err) {
    console.error('[getCpuLoadPercentage] Failed to calculate CPU load:', err);
    return { loadPercent: 0, loadAvg: 0, coreCount: 0, loadRatio: 0 };
  }
}
