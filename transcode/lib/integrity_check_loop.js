import logger from './logger';
import generate_integrity_filelist from './generate_integrity_filelist';
import integrity_check from './integrityCheck';
import wait, { getRandomDelay } from './wait';
import dayjs from './dayjs';

export default async function integrity_loop (idx = 0) {
  try {
    logger.info('STARTING TRANSCODE LOOP');
    const filelist = await generate_integrity_filelist();
    logger.info(
      `PRIMARY FILE LIST ACQUIRED. THERE ARE ${filelist.length} FILES TO INTEGRITY_CHECK.`
    );

    // if there are no files, wait 1 minute and try again
    if (filelist.length === 0) {
      return setTimeout(() => integrity_loop(), 60 * 1000);
    }

    logger.info('BEGINNING INTEGRITY_CHECK');

    const file = filelist[idx];
    await integrity_check(file);
    logger.info('INTEGRITY_CHECK COMPLETE');
  } catch (e) {
    logger.error('INTEGRITY_CHECK LOOP ERROR. RESTARTING LOOP');
    console.error(e);
  } finally {
    // generate a random number between 0 and 2 seconds
    //const randomDelay = getRandomDelay(5, 10);
    const randomDelay = 1;
    // if the current time is before 9am, run again after a random delay
    const currentHourLocalTime = dayjs().tz(process.env.TZ).hour();
    if (currentHourLocalTime < 9) {
      logger.info(`Waiting for ${randomDelay} seconds before next integrity check`);
      await wait(randomDelay);
      return integrity_loop();
    }
    logger.info('Integrity check loop completed for today. Waiting until tomorrow.');
  }
}
