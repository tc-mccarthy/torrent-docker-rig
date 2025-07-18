import { readdir, rm } from 'fs/promises';
import path from 'path';
import async, { asyncify } from 'async';
import logger from './logger';

/**
 * Recursively scans a directory and deletes any folder named `.deletedByTMM`
 * @param {string[]} basePaths - List of root paths to search in
 */
export async function deleteDeletedByTMMDirs (basePaths) {
  await async.each(basePaths, asyncify(async (basePath) => {
    try {
      await scanAndDelete(basePath);
    } catch (err) {
      console.error(`Error scanning ${basePath}: ${err.message}`);
    } finally {
      return true; // Ensure the async.each continues
    }
  }));
}

async function scanAndDelete (currentPath) {
  try {
    const entries = await readdir(currentPath, { withFileTypes: true });
    await async.each(entries, asyncify(async (entry) => {
      if (entry.isDirectory() && entry.name === '.deletedByTMM') {
        try {
          await rm(path.join(currentPath, entry.name), { recursive: true, force: true });
          logger.debug(`Deleted: ${path.join(currentPath, entry.name)}`);
        } catch (err) {
          logger.error(`Failed to delete ${path.join(currentPath, entry.name)}: ${err.message}`);
        }
      } else if (entry.isDirectory()) {
        await scanAndDelete(path.join(currentPath, entry.name)); // Recurse into subdirectories
      }
    }));
  } catch (err) {
    logger.error(`Failed to read directory ${currentPath}: ${err.message}`);
  }
}
