
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
  const query = { 'sortFields.priority': { $gte: 90 } };
  const files = await File.find(query);
  let updatedCount = 0;

  logger.info(`Assessing priority for ${files.length} files with priority >= 90`);

  // Use async.eachLimit to process files concurrently (limit 5 at a time)
  await async.eachLimit(
    files,
    5,
    asyncify(async (file) => {
      try {
        // Calculate new priority using default_priority logic
        const newPriority = await default_priority(file);
        // Only update if priority has changed
        if (file.sortFields.priority !== newPriority) {
          file.sortFields.priority = newPriority;
          await file.save();
          updatedCount += 1;
        }
      } catch (err) {
        // Log error but continue processing other files
        logger.info(
          `Error updating priority for file ${file._id}: ${err.message}`
        );
      } finally {
        // Signal completion for async.eachLimit
        return true;
      }
    })
  );

  logger.info(`Finished assessing priority for ${files.length} files with priority >= 90. Updated ${updatedCount} files.`);
  // Return the number of updated documents
  return updatedCount;
}
