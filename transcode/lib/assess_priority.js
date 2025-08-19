
/**
 * @module assess_priority
 * @description
 * Traverses all File documents and revises sortFields.priority using default_priority
 * from upsert_video.js if the current priority is 90 or greater.
 *
 * Usage:
 *   import assessPriority from './assess_priority.js';
 *   await assessPriority();
 */

import async, { asyncify } from 'async';
import File from '../models/files';
import { default_priority } from './upsert_video';
import logger from './logger';

/**
 * Updates priority for all File documents where sortFields.priority >= 90.
 * Uses async.eachLimit to process 5 files at a time for efficiency and reduced DB load.
 *
 * @returns {Promise<number>} Number of updated documents
 */
export default async function assessPriority () {
  // Query for files with high priority
  const query = { 'sortFields.priority': { $gte: 90 }, status: 'pending' };
  const files = await File.find(query);

  logger.info(`Assessing priority for ${files.length} files with priority >= 90`);

  // Prepare bulk operations for files needing priority update
  const bulkOps = [];
  await async.eachLimit(
    files,
    20,
    asyncify(async (file) => {
      try {
        const newPriority = await default_priority(file);
        if (file.sortFields.priority !== newPriority) {
          bulkOps.push({
            updateOne: {
              filter: { _id: file._id },
              update: { $set: { 'sortFields.priority': newPriority } }
            }
          });
        }
      } catch (err) {
        logger.info(`Error updating priority for file ${file._id}: ${err.message}`);
      } finally {
        return true;
      }
    })
  );

  let result = { modifiedCount: 0 };
  if (bulkOps.length > 0) {
    result = await File.bulkWrite(bulkOps, { ordered: false });
  }
  logger.info(`Finished assessing priority for ${files.length} files with priority >= 90. Updated ${result.modifiedCount} files.`);
  return result.modifiedCount;
}
