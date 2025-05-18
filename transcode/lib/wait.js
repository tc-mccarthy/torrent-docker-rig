import logger from "./logger";
// async/await compatible timeout
export default function wait(sec) {
  logger.info(`Waiting ${sec} seconds...`, { label: "WAIT" });
  return new Promise((resolve) => {
    setTimeout(resolve, sec * 1000);
  });
}
