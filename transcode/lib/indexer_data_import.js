import { getMovies, getTags as getRadarrTags } from './radarr_api';
import { getSeries, getTags as getSonarrTags } from './sonarr_api';
import File from '../models/files';
import logger from './logger';
import memcached from './memcached';

/**
 * @fileoverview Imports indexer data from Radarr and Sonarr, mapping tag IDs to names and updating File records in MongoDB.
 * This module enriches File records with indexer metadata for movies and series, including tag names, monitored status, and IDs.
 */

/**
 * Imports indexer data from Radarr and Sonarr, mapping tag IDs to names and updating File records in MongoDB.
 *
 * For each movie/series, builds a map of properties to store in indexer_data, including tag names.
 * Updates File records where the path matches the movie/series directory.
 *
 * @async
 * @function importIndexerData
 * @returns {Promise<void>} Resolves when import is complete.
 */
export async function importIndexerData () {
  const LOCK_KEY = 'indexer-data-import-lock';
  const LOCK_TTL = 1800; // 30 minutes in seconds
  // Check for lock and short-circuit if found
  if (await memcached.get(LOCK_KEY)) {
    logger.warn('Indexer data import already in progress (lock found). Aborting.');
    return false;
  }
  // Set lock before starting
  await memcached.set(LOCK_KEY, 'locked', LOCK_TTL);
  try {
    // --- RADARR ---
    logger.info('Importing Radarr indexer data...');

    // Fetch all Radarr tags using radarr_api.js
    const radarrTagObjs = await getRadarrTags();

    logger.info(radarrTagObjs, { label: 'Radarr Tags Fetched' });

    // Build an array of tag names indexed by tag ID for Radarr
    /** @type {Array<string>} */
    const radarrTagMap = [];
    radarrTagObjs.forEach((tag) => {
      radarrTagMap[tag.id] = tag.label;
    });

    // Fetch all movies from Radarr and filter to those that exist on disk
    const movies = (await getMovies()).filter((m) => m.statistics?.sizeOnDisk > 0);

    logger.info(`Radarr list captured, indexing ${movies.length} movies on disk...`);

    // Build bulkWrite operations for all Radarr movies
    const radarrBulkOps = movies.map((movie) => {
      const indexerData = {
        title: movie.title,
        overview: movie.overview,
        tmdbId: movie.tmdbId,
        imdbId: movie.imdbId,
        folderName: movie.folderName.replace(process.env.TRANSCODE_STORAGE, '/source_media'),
        tags: (movie.tags || []).map((id) => radarrTagMap[id] || id),
        poster: movie.images?.find((img) => img.coverType === 'poster')?.remoteUrl || ''
      };
      const escapedFolderName = indexerData.folderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      logger.debug(`BulkWrite: Updating indexer data for movie: ${movie.title} (${movie.tmdbId})`, { indexerData, path: { $regex: `^${escapedFolderName}`, $options: 'i' } });
      return {
        updateMany: {
          filter: { path: { $regex: `^${escapedFolderName}`, $options: 'i' } },
          update: { $set: { indexerData } }
        }
      };
    });
    logger.info(`Radarr bulkWrite operations prepared for ${radarrBulkOps.length} movies.`);
    if (radarrBulkOps.length > 0) {
      await File.bulkWrite(radarrBulkOps);
    }
    logger.info(`Radarr bulkWrite operations completed for ${radarrBulkOps.length} movies.`);

    // --- SONARR ---
    logger.info('Importing Sonarr indexer data...');

    // Fetch all Sonarr tags using sonarr_api.js
    const sonarrTagObjs = await getSonarrTags();

    // Build an array of tag names indexed by tag ID for Sonarr
    /** @type {Array<string>} */
    const sonarrTagMap = [];
    sonarrTagObjs.forEach((tag) => {
      sonarrTagMap[tag.id] = tag.label;
    });

    // Fetch all series from Sonarr and filter to those that exist on disk
    const seriesList = (await getSeries()).filter((s) => s.statistics?.sizeOnDisk > 0);

    // Build bulkWrite operations for all Sonarr series
    const sonarrBulkOps = seriesList.map((series) => {
      const indexerData = {
        title: series.title,
        tvdbId: series.tvdbId,
        imdbId: series.imdbId,
        folderName: series.path.replace(process.env.TRANSCODE_STORAGE, '/source_media'),
        tags: (series.tags || []).map((id) => sonarrTagMap[id] || id),
        poster: series.images?.find((img) => img.coverType === 'poster')?.remoteUrl || ''
      };
      const escapedSeriesFolderName = indexerData.folderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      logger.debug(`BulkWrite: Updating indexer data for series: ${series.title} (${series.tvdbId})`, { indexerData });
      return {
        updateMany: {
          filter: { path: { $regex: `^${escapedSeriesFolderName}`, $options: 'i' } },
          update: { $set: { indexerData } }
        }
      };
    });
    logger.info(`Sonarr bulkWrite operations prepared for ${sonarrBulkOps.length} series.`);
    if (sonarrBulkOps.length > 0) {
      await File.bulkWrite(sonarrBulkOps);
    }

    logger.info(`Sonarr bulkWrite operations completed for ${sonarrBulkOps.length} series.`);
    logger.info('Indexer data import complete.');
    await memcached.delete(LOCK_KEY);
    return true;
  } catch (err) {
    // Log error and stack trace for debugging
    logger.error('Indexer data import failed:', err);
    await memcached.delete(LOCK_KEY);
    throw err;
  }
}
