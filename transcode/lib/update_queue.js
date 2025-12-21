import async, { asyncify } from 'async';
import redisClient, { nsKey } from './redis';
import logger from './logger';
import config from './config';
import dayjs from './dayjs';
import ErrorLog from '../models/error';
import probe_and_upsert from './probe_and_upsert';
import upsert_video from './upsert_video';
import { trash } from './fs';
import findCMD from './find_cmd';

const {
  encode_version,
  file_ext,
  concurrent_file_checks,
  get_paths
} = config;

const PATHS = get_paths(config);

/**
 * @file update_queue.js
 *
 * Memory-safe probe scheduler that supports:
 * - Frequent incremental probes throughout the day (tracked in Redis)
 * - A nightly "sweep" behavior (keyed by date) to fill gaps when `find` misses changes
 *
 * The critical memory fix vs PR #44:
 * - Never buffer full `find` output into a giant string or split into a huge array.
 * - Never log or persist the full list of matched files.
 *
 * Instead:
 * - Stream `find -print0` results and push paths directly into an async queue.
 * - Keep only a small summary for debug and error context.
 */

/**
 * Build a small error payload safe for logging and persistence.
 * Never include full file lists or raw command output.
 *
 * @param {Object} params
 * @param {string} params.file
 * @param {string} params.probeSince
 * @param {Object|null} params.findSummary
 * @param {Error} params.error
 * @returns {Object}
 */
function buildErrorPayload ({ file, probeSince, findSummary, error }) {
  return {
    file,
    probe_since: probeSince,
    find_summary: {
      count: findSummary?.count ?? null,
      sampleHead: findSummary?.sampleHead ?? [],
      sampleTail: findSummary?.sampleTail ?? []
    },
    error: {
      message: error?.message,
      trace: error?.stack
    }
  };
}

export default async function update_queue () {
  const current_date = dayjs().format('MMDDYYYY');
  const last_probe_cache_key = nsKey(`last_probe_${encode_version}_${current_date}_a`);

  const now = dayjs();
  const seconds_until_midnight = now.endOf('day').diff(now, 'seconds') - 60;
  const date_fmt = 'YYYY-MM-DD HH:mm:ss';

  let last_probe;
  try {
    // Fallback to 12-31-1969 11:59:59 pm for a full sweep once a day
    const fallback = '1969-12-31 23:59:59';
    last_probe = (await redisClient.get(last_probe_cache_key)) || fallback;
  } catch (e) {
    logger.error('Redis GET failed (last_probe)', { error: e, key: last_probe_cache_key });
    last_probe = '1969-12-31 23:59:59';
  }

  // Be conservative (fills gaps).
  const probe_since = dayjs(last_probe).subtract(30, 'minutes').format(date_fmt);

  // Small summary object for error context; filled after find completes.
  let currentFindSummary = null;

  // Queue for probing work (bounded concurrency).
  const q = async.queue(
    asyncify(async (file) => {
      try {
        // Normalize newline artifacts just in case.
        file = file.replace(/\n+$/, '');

        const ffprobe_data = await probe_and_upsert(file, null, { touch_last_seen: true });

        // If we probed and it is already encoded, do nothing else here.
        // probe_and_upsert + your other systems will manage status transitions.
        if (ffprobe_data && ffprobe_data.format?.tags?.ENCODE_VERSION === encode_version) {
          // no-op
        }

        // Progress last_probe forward as we successfully process work.
        const ts = dayjs().format(date_fmt);
        try {
          await redisClient.set(last_probe_cache_key, ts, 'EX', seconds_until_midnight);
        } catch (e) {
          logger.error('Redis SET failed (last_probe)', { error: e, key: last_probe_cache_key });
        }
      } catch (e) {
        const payload = buildErrorPayload({
          file,
          probeSince: probe_since,
          findSummary: currentFindSummary,
          error: e
        });

        logger.error('Error probing file', payload);

        await upsert_video({
          path: file,
          error: payload,
          hasError: true
        });

        await ErrorLog.create({
          path: file,
          error: payload
        });

        // Preserve your existing "trash unreadable video" behavior.
        if (/command\s+failed/gi.test(e.message)) {
          const ext_expression = new RegExp(`\\.(${file_ext.join('|')})$`, 'i');
          if (ext_expression.test(file)) {
            try {
              await trash(file);
            } catch (trashErr) {
              logger.error('Failed to trash unreadable file', { file, error: trashErr?.message });
            }
          }
        }
      }
    }),
    concurrent_file_checks
  );

  // Drain promise helper (async.queue uses callback-style drain).
  const drainPromise = new Promise((resolve) => {
    q.drain(() => resolve());
  });

  // Stream the find results and enqueue; never hold full results in memory.
  currentFindSummary = await findCMD(PATHS, file_ext, probe_since, {
    onPath: async (rawPath) => {
      let file = rawPath;

      // Normalize to /source_media when possible, matching your container mount layout.
      if (!file.startsWith('/source_media')) {
        const idx = file.indexOf('/source_media');
        if (idx !== -1) file = file.slice(idx);
      }

      q.push(file);
    },
    sampleSize: 10
  });

  logger.info('Find completed (streamed)', {
    probe_since,
    count: currentFindSummary.count,
    sampleHead: currentFindSummary.sampleHead,
    sampleTail: currentFindSummary.sampleTail
  });

  await drainPromise;

  logger.info('update_queue completed', {
    processed: currentFindSummary.count,
    probe_since
  });
}
