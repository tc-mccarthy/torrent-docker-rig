import fs from 'fs';
import File from '../models/files';
import Cleanup from '../models/cleanup';
import logger from './logger';

export default async function db_cleanup () {
  logger.info('Cleaning up the database...');
  // first purge any files marked for delete
  await File.deleteMany({ status: 'deleted' });

  // then verify that all remaining files exist in the filesystem
  const files = await File.find({}).sort({ path: 1 });
  const to_remove = files.map((f) => f.path).filter((p) => !fs.existsSync(p));

  // delete any file whose path doesn't exist
  await File.deleteMany({
    path: { $in: to_remove }
  });

  await Cleanup.create({ paths: to_remove, count: to_remove.length });
}
