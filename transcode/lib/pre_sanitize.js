import db_cleanup from './db_cleanup';
import config from './config';
import { deleteDeletedByTMMDirs } from './deleteDeletedByTMM';

const { get_paths } = config;
const PATHS = get_paths(config);

export default async function pre_sanitize () {
  await db_cleanup();
  await deleteDeletedByTMMDirs(PATHS);
}
