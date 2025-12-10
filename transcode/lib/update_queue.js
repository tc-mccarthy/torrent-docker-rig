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

export default async function update_queue () {
  try {
    // check for a lock in redis
    const lock = await redisClient.get('update_queue_lock');

    // short circuit the function if the lock is set
    if (lock) {
      logger.debug('Update queue locked. Exiting...');
      return;
    }

    // update the status of any files who have an encode version that matches the current encode version and that haven't been marked as deleted
    await File.updateMany(
      { encode_version, status: { $ne: 'deleted' } },
      { $set: { status: 'complete' } }
    );

    // get current date
    const current_date = dayjs().format('MMDDYYYY');
    // Get the list of files to be converted
    const last_probe_cache_key = `last_probe_${encode_version}_${current_date}_${application_version}_a`;

    // get the last probe time from redis
    const last_probe =
      (await redisClient.get(last_probe_cache_key)) || '1969-12-31 23:59:59';

    const current_time = dayjs();

    // get seconds until midnight
    const seconds_until_midnight =
      86400 - current_time.diff(current_time.endOf('day'), 'seconds') - 60;

    logger.debug('Seconds until midnight', seconds_until_midnight);

    const findCMD = `find ${PATHS.map((p) => `"${p}"`).join(' ')} \\( ${file_ext
      .map((ext) => `-iname "*.${ext}"`)
      .join(' -o ')} \\) -not \\( -iname "*.tc.mkv" \\) -newermt "${dayjs(
      last_probe
    )
      .subtract(30, 'minutes')
      .format('MM/DD/YYYY HH:mm:ss')}" -print0 | sort -z | xargs -0`;

    logger.debug(findCMD, { label: 'FIND COMMAND' });

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
      // set a 60 second lock with each file so that the lock lives no longer than 60 seconds beyond the final probe
      await redisClient.set('update_queue_lock', 'locked', { EX: 60 });
      try {
        const ffprobe_data = await probe_and_upsert(file);

        // if the file is already encoded, remove it from the list
        if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
          filelist[file_idx] = null;
        }

        return true;
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

        return true;
      } finally {
        // clear the lock
        await redisClient.del('update_queue_lock');
      }
    }));

    await redisClient.set(
      last_probe_cache_key,
      current_time.format('MM/DD/YYYY HH:mm:ss'),
      { EX: seconds_until_midnight }
    );

    // clear the lock
    await redisClient.del('update_queue_lock');
    return true;
  } catch (e) {
    logger.error(e, { label: 'UPDATE QUEUE ERROR' });
    throw e;
  }
}
