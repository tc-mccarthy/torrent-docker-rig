import logger from "./logger";
import generate_integrity_filelist from "./generate_integrity_filelist";
import integrity_check from "./integrityCheck";
import wait, { getRandomDelay } from "./wait";

export default async function integrity_loop(idx = 0) {
  try {
    logger.info("STARTING TRANSCODE LOOP");
    const filelist = await generate_integrity_filelist();
    logger.info(
      `PRIMARY FILE LIST ACQUIRED. THERE ARE ${filelist.length} FILES TO INTEGRITY_CHECK.`
    );

    // if there are no files, wait 1 minute and try again
    if (filelist.length === 0) {
      return setTimeout(() => integrity_loop(), 60 * 1000);
    }

    logger.info("BEGINNING INTEGRITY_CHECK");

    const file = filelist[idx];
    await integrity_check(file);
    logger.info("INTEGRITY_CHECK COMPLETE");
  } catch (e) {
    logger.error("INTEGRITY_CHECK LOOP ERROR. RESTARTING LOOP");
    console.error(e);
  } finally {
    // generate a random number between 0 and 2 seconds
    const randomDelay = getRandomDelay(5, 10);

    await wait(randomDelay);
    return integrity_loop();
  }
}
