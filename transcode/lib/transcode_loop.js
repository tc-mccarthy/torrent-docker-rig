import logger from './logger';
import generate_filelist from './generate_filelist';
import update_status from './update_status';
import transcode from './transcode';
import memcached from './memcached';
import { getRandomDelay } from './wait';

export default async function transcode_loop (idx = 0) {
  let delay = 0;
  try {
    logger.info('STARTING A TRANSCODE JOB');
    if (await memcached.get('transcode_loop_lock')) {
      throw new Error('Another worker is fetching the pool. Please wait.');
    }
    // set a lock to prevent multiple workers from running this loop at the same time
    await memcached.set('transcode_loop_lock', 'locked', 2);

    const filelist = await generate_filelist({ limit: 1 });

    // if there are no files, wait 1 minute and try again
    if (filelist.length === 0) {
      return setTimeout(() => transcode_loop(), 60 * 1000);
    }

    logger.info('UPDATING METRICS');
    await update_status();

    const file = filelist[idx];

    if (await file.hasLock('transcode')) {
      throw new Error(`File ${file.path} is already locked for transcode.`);
    }

    logger.info('STARTING FFMPEG TRANSCODE');
    await transcode(file);

    logger.info('TRANSCODE COMPLETE');
  } catch (e) {
    logger.error('TRANSCODE LOOP ERROR. RESTARTING LOOP');
    delay = getRandomDelay(2, 5) * 1000; // random delay between 2 and 5 seconds
    console.error(e);
  } finally {
    logger.info('TRANSCODE LOOP COMPLETED. STARTING NEXT JOB');
    return setTimeout(() => { transcode_loop(); }, delay);
  }
}
