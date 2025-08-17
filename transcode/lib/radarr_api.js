
import { setTimeout as delay } from 'timers/promises';
import async, { asyncify } from 'async';
import memcached from './memcached';
import logger from './logger';

/**
 * Radarr API Client (ESModule)
 *
 * Provides functions to interact with a Radarr server using its REST API.
 * The API key is read from the RADARR_API_KEY environment variable.
 *
 * Usage:
 *   import { getMovies, updateMovie, getSystemStatus, getMoviesByTag } from './radarr_api.js';
 *
 *   const movies = await getMovies();
 *   await updateMovie(movieId, movieData);
 *
 * All functions throw on error and return parsed JSON responses.
 */

const RADARR_API_KEY = process.env.RADARR_API_KEY;
const RADARR_URL = process.env.RADARR_URL || 'http://localhost:7878';

if (!RADARR_API_KEY) {
  throw new Error('RADARR_API_KEY environment variable is not set');
}

/**
 * Helper to build Radarr API URLs.
 * @param {string} path - API endpoint path (e.g., '/api/v3/movie')
 * @returns {string} Full URL to the Radarr API endpoint
 */
function buildUrl (path) {
  return `${RADARR_URL}${path}`;
}

/**
 * Helper to build headers for Radarr API requests.
 * @returns {Object} Headers including API key
 */
function buildHeaders () {
  return {
    'X-Api-Key': RADARR_API_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

/**
 * Utility function to make Radarr API requests.
 * Handles endpoint, method, body, and error handling.
 *
 * @param {string} endpoint - API endpoint path (e.g., '/api/v3/movie')
 * @param {string} [method='GET'] - HTTP method
 * @param {Object|null} [body=null] - Request body (for POST/PUT)
 * @returns {Promise<Object>} Parsed JSON response
 * @throws {Error} If the request fails
 */
async function radarrRequest (endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: buildHeaders()
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(buildUrl(endpoint), options);
  if (!res.ok) {
    throw new Error(`Radarr API request failed: ${res.status} ${res.statusText} (${endpoint})`);
  }
  return res.json();
}

/**
 * Fetch all movies from Radarr.
 * @returns {Promise<Array>} Array of movie objects
 */

/**
 * Fetch all series from Sonarr.
 * @returns {Promise<Array>} Array of series objects
 */

/**
 * Fetch all movies from Radarr.
 * @returns {Promise<Array>} Array of movie objects
 */
export async function getMovies () {
  return radarrRequest('/api/v3/movie');
}

/**
 * Update a movie in Radarr.
 * @param {number} movieId - The Radarr movie ID
 * @param {Object} movieData - The full movie object to update
 * @returns {Promise<Object>} The updated movie object
 */

/**
 * Update a series in Sonarr.
 * @param {number} seriesId - The Sonarr series ID
 * @param {Object} seriesData - The full series object to update
 * @returns {Promise<Object>} The updated series object
 */

/**
 * Update a movie in Radarr.
 * @param {number} movieId - The Radarr movie ID
 * @param {Object} movieData - The full movie object to update
 * @returns {Promise<Object>} The updated movie object
 */
export async function updateMovie (movieId, movieData) {
  return radarrRequest(`/api/v3/movie/${movieId}`, 'PUT', movieData);
}

/**
 * Get Radarr system status.
 * @returns {Promise<Object>} System status info
 */

/**
 * Get Sonarr system status.
 * @returns {Promise<Object>} System status info
 */

/**
 * Get Radarr system status.
 * @returns {Promise<Object>} System status info
 */
export async function getSystemStatus () {
  return radarrRequest('/api/v3/system/status');
}

/**
 * List all movies that have a specific tag.
 * Resolves the tag name to its ID, then filters movies by tag ID.
 *
 * @param {string} tagName - The tag value to filter by (case-sensitive)
 * @returns {Promise<Array>} Array of movie objects with the specified tag
 * @throws {Error} If the tag is not found or API calls fail
 */

/**
 * List all series that have a specific tag.
 * Resolves the tag name to its ID, then filters series by tag ID.
 *
 * @param {string} tagName - The tag value to filter by (case-sensitive)
 * @returns {Promise<Array>} Array of series objects with the specified tag
 * @throws {Error} If the tag is not found or API calls fail
 */

/**
 * List all movies that have a specific tag.
 * Uses a 10-minute memcached cache and lock/wait for concurrency.
 *
 * @param {string} tagName - The tag value to filter by (case-sensitive)
 * @returns {Promise<Array>} Array of movie objects with the specified tag
 * @throws {Error} If the tag is not found or API calls fail
 */
export async function getMoviesByTag (tagName) {
  try {
    const cacheKey = `radarr-tag-${tagName}`;
    const lockKey = `${cacheKey}-lock`;
    const cacheTtl = 600; // 10 minutes
    const lockTtl = 30; // 30 seconds lock

    // Try to get from cache
    const cached = await memcached.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Try to acquire lock
    const gotLock = await memcached.get(lockKey, 'locked', lockTtl);
    if (gotLock) {
      // Wait for cache to be built by another invocation
      let waited = 0;
      while (waited < lockTtl * 1000) {
        await delay(500);
        const cached = await memcached.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
        waited += 500;
      }
      throw new Error(`Timeout waiting for cache for tag '${tagName}'`);
    }

    await memcached.set(lockKey, 'locked', lockTtl);

    // Build cache
    const tags = await radarrRequest('/api/v3/tag');
    const tagObj = tags.find((t) => t.label === tagName);
    if (!tagObj) {
      throw new Error(`Radarr getMoviesByTag: tag '${tagName}' not found`);
    }
    const tagId = tagObj.id;
    const movies = await getMovies();
    const result = movies.filter((m) => Array.isArray(m.tags) && m.tags.includes(tagId));
    await memcached.set(cacheKey, JSON.stringify(result), cacheTtl);
    return result;
  } catch (err) {
    logger.error(`Radarr getMoviesByTag: error fetching tag '${tagName}': ${err.message}`);
    throw err;
  }
}

/**
 * List all files in a series by series ID.
 *
 * @param {number} seriesId - The Sonarr series ID
 * @returns {Promise<Array>} Array of file objects for the series
 * @throws {Error} If the API call fails
 */

/**
 * List all files in a movie by movie ID.
 *
 * @param {number} movieId - The Radarr movie ID
 * @returns {Promise<Array>} Array of file objects for the movie
 * @throws {Error} If the API call fails
 */
export async function getMovieFiles (movieId) {
  // Radarr API: /api/v3/moviefile?movieId=<id>
  const files = await radarrRequest(`/api/v3/moviefile?movieId=${movieId}`);
  return files;
}

/**
 * Get all episode files for all series matching a tag.
 * Calls getSeriesByTag, then gets episode files for each series.
 * Returns a flat array of all episode files found.
 *
 * @param {string} tagName - The tag value to filter by (case-sensitive)
 * @returns {Promise<Array>} Array of episode file objects across all matching series
 * @throws {Error} If the tag is not found or API calls fail
 */
/**
 * Get all episode files for all series matching a tag.
 * Uses async.eachSeries for sequential async processing.
 * Returns a flat array of all episode files found.
 *
 * @param {string} tagName - The tag value to filter by (case-sensitive)
 * @returns {Promise<Array>} Array of episode file objects across all matching series
 * @throws {Error} If the tag is not found or API calls fail
 */

/**
 * Get all movie files for all movies matching a tag.
 * Uses async.eachSeries for sequential async processing.
 * Returns a flat array of all movie files found.
 *
 * @param {string} tagName - The tag value to filter by (case-sensitive)
 * @returns {Promise<Array>} Array of movie file objects across all matching movies
 * @throws {Error} If the tag is not found or API calls fail
 */
export async function getMovieFilesByTag (tagName) {
  const movieList = await getMoviesByTag(tagName);
  const allFiles = [];
  await async.eachSeries(
    movieList,
    asyncify(async (movie) => {
      try {
        const files = await getMovieFiles(movie.id);
        allFiles.push(...files);
      } catch (err) {
        logger.error(`Radarr getMovieFilesByTag: error fetching files for movie ID ${movie.id}: ${err.message}`);
      } finally {
        return true;
      }
    })
  );
  return allFiles;
}
