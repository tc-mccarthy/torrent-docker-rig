import async, { asyncify } from 'async';
import redisClient from './redis';
import logger from './logger';
import config from './config';
import dayjs from './dayjs';
import ErrorLog from '../models/error';
import File from '../models/files';
import exec_promise from './exec_promise';
import probe_and_upsert from './probe_and_upsert';
import upsert_video from './upsert_video';
import { trash } from './fs';

const { encode_version, file_ext, concurrent_file_checks, get_paths, application_version } = config;
const PATHS = get_paths(config);

/**
 * Update the transcoding queue and metadata index.
 *
 * Behavior:
 * - During the day, we mostly rely on `find -newermt <last_probe>` to pick up changes quickly.
 * - At midnight (by design), we perform a full sweep to fill in any gaps.
 *
 * Efficiency:
 * - The full sweep can still be fast because `probe_and_upsert()` will skip ffprobe when
 *   a cheap filesystem fingerprint hasn't changed.
 *
 * Concurrency:
 * - Uses a Redis lock to prevent overlapping runs.
 */
export default async function update_queue () {
  const lockKey = 'update_queue_lock';
  try {
    logger.info('update_queue: Starting update queue process');
    // update the status of any files who have an encode version that matches the current encode version and that haven't been marked as deleted
    // Use $in for status to leverage the compound index and improve performance
    const nonDeletedStatuses = ['pending', 'complete', 'ignore', 'error']; // add any other valid statuses
    logger.info('update_queue: Updating statuses of previously encoded files to complete');
    await File.updateMany(
      { encode_version, status: { $in: nonDeletedStatuses } },
      { $set: { status: 'complete' } }
    );

    // get current date
    const current_date = dayjs().format('MMDDYYYY');
    // Get the list of files to be converted
    const last_probe_cache_key = `last_probe_${encode_version}_${current_date}_${application_version}_a`;

    // get the last probe time from redis
    let last_probe;
    try {
      last_probe = (await redisClient.get(last_probe_cache_key)) || '1969-12-31 23:59:59';
    } catch (e) {
      logger.error('Redis GET failed', { error: e, key: last_probe_cache_key });
      last_probe = '1969-12-31 23:59:59';
    }

    logger.debug('Last probe time', { last_probe });

    const current_time = dayjs();

    // Prevent overlapping runs (especially important with concurrent workers).
    // Use an expiring lock so a crash doesn't deadlock the system.
    const lockValue = `${process.pid}:${current_time.valueOf()}`;
    const lockTTLSeconds = 6 * 60 * 60; // 6 hours (adjust if your sweep can exceed this)

    let acquired;
    try {
      acquired = await redisClient.set(lockKey, lockValue, { NX: true, EX: lockTTLSeconds });
    } catch (e) {
      logger.error('Redis SET (lock) failed', { error: e, key: lockKey });
      return false;
    }
    if (!acquired) {
      logger.info('update_queue: lock already held; skipping this run');
      return false;
    }

    // Set cache expiry to 24 hours (86400 seconds) since the key changes daily
    const CACHE_EXPIRY_SECONDS = 24 * 60 * 60;

    const findCMD = `find ${PATHS.map((p) => `"${p}"`).join(' ')} \\( ${file_ext
      .map((ext) => `-iname "*.${ext}"`)
      .join(' -o ')} \\) -not \\( -iname "*.tc.mkv" \\) -newermt "${dayjs(
      last_probe
    )
      .subtract(30, 'minutes')
      .format('MM/DD/YYYY HH:mm:ss')}" -print0 | sort -z | xargs -0`;

    logger.info(findCMD, { label: 'FIND COMMAND' });

    const { stdout, stderr } = await exec_promise(findCMD);

    const filelist = stdout
      .split(/\s*\/source_media/)
      .filter((j) => j)
      .map((p) => `/source_media${p}`.replace('\x00', ''))
      .slice(1);

    logger.debug('', { label: 'NEW FILES IDENTIFIED. PROBING...' });

    await async.eachLimit(filelist, concurrent_file_checks, asyncify(async (file) => {
      const file_idx = filelist.indexOf(file);
      logger.debug('Processing file', {
        file,
        file_idx,
        total: filelist.length,
        pct: Math.round((file_idx / filelist.length) * 100)
      });
      if (filelist.length > 0) {
        logger.info(`update_queue: Processing file ${file_idx + 1} of ${filelist.length} (${Math.round(((file_idx + 1) / filelist.length) * 100)}%)`);
      }
      // set a 60 second lock with each file so that the lock lives no longer than 60 seconds beyond the final probe
      try {
        await redisClient.set('update_queue_lock', 'locked', { EX: 60 });
      } catch (e) {
        logger.error('Redis SET (file lock) failed', { error: e, key: 'update_queue_lock', file });
      }
      try {
        const ffprobe_data = await probe_and_upsert(file, null, { touch_last_seen: true });

        // if the file is already encoded, remove it from the list
        if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
          filelist[file_idx] = null;
        }
      } catch (e) {
        logger.error(e, { label: 'FFPROBE ERROR', file });

        await upsert_video({
          path: file,
          error: { error: e.message, stdout, stderr, trace: e.stack },
          hasError: true
        });

        await ErrorLog.create({
          path: file,
          error: { error: e.message, stdout, stderr, trace: e.stack }
        });

        // if the file itself wasn't readable by ffprobe, remove it from the list
        if (/command\s+failed/gi.test(e.message)) {
          // if this is an unreadable file, trash it.
          const ext_expression = new RegExp(`.${file_ext.join('|')}`, 'i');
          if (ext_expression.test(e.message)) {
            logger.error(file, {
              label: 'UNREADABLE VIDEO FILE. REMOVING FROM LIST'
            });
            trash(file);
          }
        }

        // if the video stream is corrupt, delete it
        if (/display_aspect_ratio/gi.test(e.message)) {
          logger.error(file, {
            label: 'UNREADABLE VIDEO STREAM. REMOVING FROM LIST'
          });
          trash(file);
        }

        // any ffprobe command failure, this should be removed from the list
        filelist[file_idx] = null;
      } finally {
        return true;
        // clear the lock        // (Job-level Redis lock released at end of update_queue)
      }
    }));

    try {
      await redisClient.set(
        last_probe_cache_key,
        current_time.format('MM/DD/YYYY HH:mm:ss'),
        { EX: CACHE_EXPIRY_SECONDS }
      );
    } catch (e) {
      logger.error('Redis SET (last_probe_cache_key) failed', { error: e, key: last_probe_cache_key });
    }

    // clear the lock        // (Job-level Redis lock released at end of update_queue)
    return true;
  } catch (e) {
    logger.error(e, { label: 'UPDATE QUEUE ERROR' });
    throw e;
  } finally {
    // Always release the job lock if we acquired it.
    // Safe even if the key expired or was never acquired.
    try {
      await redisClient.del(lockKey);
    } catch (e) {
      logger.error('Redis DEL (lock) failed', { error: e, key: lockKey });
    }

    logger.info('update_queue process complete.');
  }
}
