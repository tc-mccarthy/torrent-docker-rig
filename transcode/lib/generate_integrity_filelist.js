import logger from './logger';
import File from '../models/files';

export default async function generate_integrity_filelist (limit = 1000) {
  logger.info('GENERATING INTEGRITY FILE LIST');
  // query for any files that have an encode version that doesn't match the current encode version
  // do not hydrate results into models
  // sort by priority, then size, then width
  const filelist = await File.find({
    status: 'pending',
    integrityCheck: false,
    $or: [{ 'lock.integrity': { $exists: false } }, { 'lock.integrity': null }, { 'lock.integrity': { $lt: new Date() } }] // exclude files that have a lock for integrity check
  })
    .sort({
      'sortFields.priority': 1,
      'sortFields.size': 1,
      'sortFields.width': -1
    })
    .limit(limit);

  // send back full list
  return filelist;
}
