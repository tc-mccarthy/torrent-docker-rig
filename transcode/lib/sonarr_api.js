import { setTimeout as delay } from 'timers/promises';
import async, { asyncify } from 'async';
import memcached from './memcached';
import logger from './logger';

/**
 * Sonarr API Client (ESModule)
 *
 * Provides functions to interact with a Sonarr server using its REST API.
 * The API key is read from the SONARR_API_KEY environment variable.
 *
 * Usage:
 *   import { getSeries, updateSeries, getSystemStatus, getSeriesByTag } from './sonarr_api.js';
 *
 *   const series = await getSeries();
 *   await updateSeries(seriesId, seriesData);
 *
 * All functions throw on error and return parsed JSON responses.
 */

const SONARR_API_KEY = process.env.SONARR_API_KEY;
const SONARR_URL = process.env.SONARR_URL || 'http://localhost:8989';

if (!SONARR_API_KEY) {
  throw new Error('SONARR_API_KEY environment variable is not set');
}

/**
 * Helper to build Sonarr API URLs.
 * @param {string} path - API endpoint path (e.g., '/api/v3/series')
 * @returns {string} Full URL to the Sonarr API endpoint
 */
function buildUrl (path) {
  return `${SONARR_URL}${path}`;
}

/**
 * Helper to build headers for Sonarr API requests.
 * @returns {Object} Headers including API key
 */
function buildHeaders () {
  return {
    'X-Api-Key': SONARR_API_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}

/**
 * Utility function to make Sonarr API requests.
 * Handles endpoint, method, body, and error handling.
 *
 * @param {string} endpoint - API endpoint path (e.g., '/api/v3/series')
 * @param {string} [method='GET'] - HTTP method
 * @param {Object|null} [body=null] - Request body (for POST/PUT)
 * @returns {Promise<Object>} Parsed JSON response
 * @throws {Error} If the request fails
 */
async function sonarrRequest (endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: buildHeaders()
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(buildUrl(endpoint), options);
  if (!res.ok) {
    throw new Error(`Sonarr API request failed: ${res.status} ${res.statusText} (${endpoint})`);
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
export async function getSeries () {
  return sonarrRequest('/api/v3/series');
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
export async function updateSeries (seriesId, seriesData) {
  return sonarrRequest(`/api/v3/series/${seriesId}`, 'PUT', seriesData);
}

/**
 * Get Radarr system status.
 * @returns {Promise<Object>} System status info
 */

/**
 * Get Sonarr system status.
 * @returns {Promise<Object>} System status info
 */
export async function getSystemStatus () {
  return sonarrRequest('/api/v3/system/status');
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
export async function getSeriesByTag (tagName) {
  try {
  /**
   * Get all series with a specific tag, using a 10-minute memcached cache.
   * Handles concurrent invocations with a lock/wait pattern.
   *
   * @param {string} tagName - The tag value to filter by (case-sensitive)
   * @returns {Promise<Array>} Array of series objects with the specified tag
   * @throws {Error} If the tag is not found or API calls fail
   */
    const cacheKey = `sonarr-tag-${tagName}`;
    const lockKey = `${cacheKey}-lock`;
    const cacheTtl = 600; // 10 minutes
    const lockTtl = 30; // 30 seconds lock

    // Try to get from cache
    const cached = await memcached.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    // Try to acquire lock
    const gotLock = await memcached.get(lockKey);

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

    // Build cache
    await memcached.set(lockKey, 'locked', lockTtl);
    const tags = await sonarrRequest('/api/v3/tag');
    const tagObj = tags.find((t) => t.label === tagName);
    if (!tagObj) {
      throw new Error(`Sonarr getSeriesByTag: tag '${tagName}' not found`);
    }

    const tagId = tagObj.id;
    const series = await getSeries();
    const result = series.filter((s) => Array.isArray(s.tags) && s.tags.includes(tagId));
    await memcached.set(cacheKey, JSON.stringify(result), cacheTtl);

    return result;
  } catch (err) {
    logger.error(`Sonarr getSeriesByTag: error fetching tag '${tagName}': ${err.message}`);
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
export async function getSeriesFiles (seriesId) {
  // Sonarr API: /api/v3/episodefile?seriesId=<id>
  const files = await sonarrRequest(`/api/v3/episodefile?seriesId=${seriesId}`);
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
export async function getEpisodesByTag (tagName) {
  const seriesList = await getSeriesByTag(tagName);
  const allEpisodes = [];
  await async.eachSeries(
    seriesList,
    asyncify(async (series) => {
      try {
        const files = await getSeriesFiles(series.id);
        allEpisodes.push(...files);
      } catch (err) {
        logger.error(`Sonarr getEpisodesByTag: error fetching episodes for series '${series.id}': ${err.message}`);
      } finally {
        return true;
      }
    })
  );

  return allEpisodes;
}

/**
 * Fetch all tags from Sonarr.
 *
 * @returns {Promise<Array>} Array of tag objects
 * @throws {Error} If the API call fails
 */
export async function getTags () {
  // Sonarr API: /api/v3/tag
  return sonarrRequest('/api/v3/tag');
}
