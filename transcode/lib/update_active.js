import fs from 'fs';
import path from 'path';
import { setTimeout } from 'node:timers/promises';
import logger from './logger';

/**
 * @file update_active.js
 *
 * Maintains /usr/app/output/active.json, a merged view of per-process `active-*.json` snapshots.
 *
 * Memory safety:
 * - Avoids shelling out to `find` + buffering stdout into large strings/arrays.
 * - Avoids parsing arbitrarily large numbers of active files every second.
 * - Uses adaptive backoff when there are no active files.
 *
 * Behavior:
 * - Reads "recent" active-*.json files (modified in the last ~30 seconds).
 * - Writes pending-active.json then atomically moves to active.json.
 * - Periodically purges stale active-*.json files (>300 minutes old).
 */

const OUTPUT_DIR = '/usr/app/output';
const ACTIVE_PREFIX = 'active-';
const ACTIVE_SUFFIX = '.json';

function nowMs () {
  return Date.now();
}

function safeReadJson (filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    logger.error('Failed to read/parse active file', { file: filePath, error: e?.message });
    return null;
  }
}

function listActiveFiles () {
  try {
    return fs.readdirSync(OUTPUT_DIR)
      .filter((name) => name.startsWith(ACTIVE_PREFIX) && name.endsWith(ACTIVE_SUFFIX))
      .map((name) => path.join(OUTPUT_DIR, name));
  } catch (e) {
    logger.error('Failed to list output directory', { dir: OUTPUT_DIR, error: e?.message });
    return [];
  }
}

function purgeOld (files, maxAgeMs) {
  const cutoff = nowMs() - maxAgeMs;
  files.forEach((f) => {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs < cutoff) {
        fs.rmSync(f, { force: true });
      }
    } catch (e) {
      logger.error('Failed to purge old active file', { file: f, error: e.message });
    }
  });
}

/**
 * Main loop.
 * @returns {Promise<void>}
 */
export default async function update_active () {
  // Adaptive polling: faster when active files exist, slower when idle.
  let delayMs = 1000;

  // Run forever; use a loop rather than recursion to avoid accidental overlapping calls.

  while (true) {
    try {
      const allActive = listActiveFiles();

      // Purge very old files (300 minutes) once per loop (cheap stat calls).
      purgeOld(allActive, 300 * 60 * 1000);

      // Select "recent" files (last 30 seconds). This matches your prior `-mmin -0.5`.
      const recentCutoff = nowMs() - 30 * 1000;
      const recent = [];
      allActive.forEach((f) => {
        try {
          const st = fs.statSync(f);
          if (st.mtimeMs >= recentCutoff) {
            recent.push(f);
          }
        } catch {
          // ignore error
        }
      });

      if (!recent.length) {
        // No active jobs: back off to reduce churn.
        delayMs = Math.min(10_000, Math.round(delayMs * 1.5));
        await setTimeout(delayMs);
        // skip to next iteration
        return;
      }

      // Active jobs exist: tighten polling.
      delayMs = 1000;

      const activeData = [];
      recent.forEach((f) => {
        const parsed = safeReadJson(f);
        if (parsed) {
          activeData.push(parsed);
        }
      });

      // Sort by timestamp if available (keeps output stable)
      activeData.sort((a, b) => {
        const ta = Number(a?.timestamp || a?.updated_at || 0);
        const tb = Number(b?.timestamp || b?.updated_at || 0);
        return tb - ta;
      });

      const pendingPath = path.join(OUTPUT_DIR, 'pending-active.json');
      const finalPath = path.join(OUTPUT_DIR, 'active.json');

      fs.writeFileSync(pendingPath, JSON.stringify(activeData, null, 2));
      fs.renameSync(pendingPath, finalPath);

      await setTimeout(delayMs);
    } catch (e) {
      logger.error('update_active loop error', { error: e?.message, trace: e?.stack });
      // Backoff a bit on error to avoid tight failure loops.
      await setTimeout(5000);
    }
  }
}
