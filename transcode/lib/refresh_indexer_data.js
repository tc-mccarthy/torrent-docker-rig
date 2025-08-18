import importIndexerData from './indexer_data_import';
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
 *   refresh_indexer_data();
 */

/**
 * Refreshes indexer data and updates file priorities.
 * First imports indexer data, then revises priorities using assessPriority.
 * Errors are logged but do not throw.
 */
export default function refresh_indexer_data () {
  // Import indexer data, then update priorities
  importIndexerData()
    .then(() => assessPriority())
    .catch((err) => {
      logger.error('Failed to import indexer data:', err);
    });
}
