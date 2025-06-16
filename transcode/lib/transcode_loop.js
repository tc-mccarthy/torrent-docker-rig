import logger from './logger';
import generate_filelist from './generate_filelist';
import update_status from './update_status';
import transcode from './transcode';

export default async function transcode_loop (idx = 0) {
  try {
    logger.info('STARTING A TRANSCODE JOB');
    const filelist = await generate_filelist(1);

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
    console.error(e);
  } finally {
    logger.info('TRANSCODE LOOP COMPLETED. STARTING NEXT JOB');
    return transcode_loop();
  }
}
