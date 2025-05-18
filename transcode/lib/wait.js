import logger from "./logger";
// async/await compatible timeout
export default function wait(sec) {
  logger.info(`Waiting ${sec} seconds...`, { label: "WAIT" });
  return new Promise((resolve) => {
    setTimeout(resolve, sec * 1000);
  });
}

export function getRandomDelay(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1) + min);
}
