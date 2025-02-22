import db_cleanup from './db_cleanup';
import config from './config';
import logger from './logger';
import exec_promise from './exec_promise';

const { get_paths } = config;
const PATHS = get_paths(config);

export default async function pre_sanitize () {
  await db_cleanup();
  const findCMD = `find ${PATHS.map((p) => `"${p}"`).join(
    ' '
  )} -iname ".deletedByTMM" -type d -exec rm -Rf {} \\;`;
  logger.info(findCMD, { label: 'PRE-SANITIZE COMMAND' });
  await exec_promise(findCMD);
}
