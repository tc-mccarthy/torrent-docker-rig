import logger from './logger';
import generate_filelist from './generate_filelist';
import update_status from './update_status';
import transcode from './transcode';
import wait from './wait';

export default async function transcode_loop (idx = 0) {
  try {
    logger.info('STARTING TRANSCODE LOOP');
    const filelist = await generate_filelist();
    logger.info(
      `PRIMARY FILE LIST ACQUIRED. THERE ARE ${filelist.length} FILES TO TRANSCODE.`
    );

    // if there are no files, wait 1 minute and try again
    if (filelist.length === 0) {
      return setTimeout(() => transcode_loop(), 60 * 1000);
    }

    await update_status();
    logger.info('BEGINNING TRANSCODE');

    const file = filelist[idx];
    await transcode(file);
    logger.info('TRANSCODE COMPLETE');

    // if there are more files, run the loop again
    if (filelist.length > 1) {
      logger.info('MORE FILES TO TRANSCODE. RUNNING LOOP AGAIN');

      // generate a random number between 0 and 2 seconds
      const randomDelay = Math.floor(Math.random() * 2000);

      await wait(randomDelay);
      return transcode_loop();
    }
  } catch (e) {
    logger.error('TRANSCODE LOOP ERROR. RESTARTING LOOP');
    console.error(e);
    return transcode_loop();
  }
}
