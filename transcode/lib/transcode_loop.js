import logger from "./logger";
import generate_filelist from "./generate_filelist";
import update_status from "./update_status";
import transcode from "./transcode";
import wait, { getRandomDelay } from "./wait";

export default async function transcode_loop(idx = 0) {
  try {
    logger.info("STARTING TRANSCODE LOOP");
    const filelist = await generate_filelist();
    logger.info(
      `PRIMARY FILE LIST ACQUIRED. THERE ARE ${filelist.length} FILES TO TRANSCODE.`
    );

    // if there are no files, wait 1 minute and try again
    if (filelist.length === 0) {
      return setTimeout(() => transcode_loop(), 60 * 1000);
    }

    await update_status();
    logger.info("BEGINNING TRANSCODE");

    const file = filelist[idx];
    await transcode(file);
    logger.info("TRANSCODE COMPLETE");
  } catch (e) {
    logger.error("TRANSCODE LOOP ERROR. RESTARTING LOOP");
    console.error(e);
  } finally {
    // generate a random number between 0 and 2 seconds
    const randomDelay = getRandomDelay(0, 2);

    await wait(randomDelay);
    return transcode_loop();
  }
}
