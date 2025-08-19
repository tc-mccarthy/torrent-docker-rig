import async, { asyncify } from 'async';
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

    // Build an array of tag names indexed by tag ID for Radarr
    /** @type {Array<string>} */
    const radarrTagMap = [];
    radarrTagObjs.forEach((tag) => {
      radarrTagMap[tag.id] = tag.label;
    });

    // Fetch all movies from Radarr and filter to those that exist on disk
    const movies = (await getMovies()).filter((m) => m.statistics?.sizeOnDisk > 0);

    logger.info(`Radarr list captured, indexing ${movies.length} movies on disk...`);

    // Iterate over movies and update File records with indexer data (5 at a time)
    await async.eachLimit(movies, 5, asyncify(async (movie) => {
      /**
       * @type {Object}
       * @property {string} title - Movie title
       * @property {number} year - Release year
       * @property {number} tmdbId - TMDB ID
       * @property {string} imdbId - IMDB ID
       * @property {string} path - File path
       * @property {Array<string|number>} tags - Tag names (or IDs if missing)
       * @property {boolean} monitored - Monitored status
       * @property {string} status - Movie status
       */
      const indexerData = {
        title: movie.title,
        overview: movie.overview,
        tmdbId: movie.tmdbId,
        imdbId: movie.imdbId,
        folderName: movie.folderName.replace(process.env.TRANSCODE_STORAGE, '/source_media'),
        tags: (movie.tags || []).map((id) => radarrTagMap[id] || id),
        poster: movie.images?.find((img) => img.coverType === 'poster')?.remoteUrl || ''
      };

      logger.debug(`Updating indexer data for movie: ${movie.title} (${movie.tmdbId})`, { indexerData, path: { $regex: indexerData.folderName, $options: 'i' } });
      // Update File records in MongoDB where record path starts with movie folderName (case-insensitive, escapes special chars)
      const escapedFolderName = indexerData.folderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await File.updateMany(
        { path: { $regex: `^${escapedFolderName}`, $options: 'i' } },
        { $set: { indexerData } }
      );

      return true;
    }));

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

    // Iterate over series and update File records with indexer data (5 at a time)
    await async.eachLimit(seriesList, 5, asyncify(async (series) => {
      /**
       * @type {Object}
       * @property {string} title - Series title
       * @property {number} tvdbId - TVDB ID
       * @property {string} imdbId - IMDB ID
       * @property {string} path - File path
       * @property {Array<string|number>} tags - Tag names (or IDs if missing)
       * @property {boolean} monitored - Monitored status
       * @property {string} status - Series status
       */
      const indexerData = {
        title: series.title,
        tvdbId: series.tvdbId,
        imdbId: series.imdbId,
        folderName: series.path.replace(process.env.TRANSCODE_STORAGE, '/source_media'),
        tags: (series.tags || []).map((id) => sonarrTagMap[id] || id),
        poster: series.images?.find((img) => img.coverType === 'poster')?.remoteUrl || ''
      };

      logger.debug(`Updating indexer data for series: ${series.title} (${series.tvdbId})`, { indexerData });

      // Update File records in MongoDB where record path starts with series folderName (case-insensitive, escapes special chars)
      const escapedSeriesFolderName = indexerData.folderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await File.updateMany(
        { path: { $regex: `^${escapedSeriesFolderName}`, $options: 'i' } },
        { $set: { indexerData } }
      );

      return true;
    }));

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
