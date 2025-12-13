import { importIndexerData } from './indexer_data_import';
import assessPriority from './assess_priority';
import logger from './logger';
/**
 * @module refresh_indexer_data
 * @description
 * Imports indexer data from Radarr/Sonarr and then updates file priorities.
 * Handles errors gracefully and logs failures.
 *
 * Usage:
 *   import refresh_indexer_data from './refresh_indexer_data.js';
 *   await refresh_indexer_data();
 */

/**
 * Refreshes indexer data and updates file priorities.
 *
 * This function first imports indexer data (from Radarr/Sonarr),
 * then revises priorities using assessPriority. All errors are
 * logged but do not throw, so the calling process is not interrupted.
 *
 * @function
 * @returns {Promise<void>} Resolves when refresh is complete (or failed gracefully).
 */
export default async function refresh_indexer_data () {
  try {
    // Import indexer data from Radarr/Sonarr
    await importIndexerData();
    // Update file priorities based on new indexer data
    await assessPriority();
  } catch (err) {
    // Log any errors, but do not throw
    logger.error('Failed to import indexer data:', err);
  }
}
