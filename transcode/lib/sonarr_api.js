// sonarr_api.js (streaming JSON, native fetch, ESModule)
//
// Sonarr API client for Node.js 22+ using native fetch and stream-json for efficient large payload handling.
// All requests are streamed and parsed for minimal memory usage.
// Usage:
//   import { getSeries, updateSeries, getSystemStatus, getTags, getSeriesByTag, getEpisodeFiles, getEpisodeFilesByTag } from './sonarr_api.js';
//   const series = await getSeries();
//   await updateSeries(seriesId, seriesData);

import { setTimeout as delay } from 'timers/promises';
import async, { asyncify } from 'async';
import logger from './logger';
import redisClient, { nsKey } from './redis';
import streamJsonReq from './stream-json-req';

/**
 * Builds a Redis key for Sonarr GET requests, namespaced by endpoint.
 * @param {string} endpoint - The Sonarr API endpoint (e.g., '/api/v3/series').
 * @returns {string} The Redis key for caching.
 */
function sonarrRedisKey (endpoint) {
  return nsKey(`sonarr:${endpoint}`);
}

/**
 * Stores data in Redis for a given endpoint, with no expiration (persistent backup).
 * @param {string} endpoint - The Sonarr API endpoint.
 * @param {Object|Array} data - The data to cache.
 * @returns {Promise<void>}
 */
async function storeSonarrCache (endpoint, data) {
  const key = sonarrRedisKey(endpoint);
  await redisClient.set(key, JSON.stringify(data));
}

/**
 * Retrieves cached data from Redis for a given endpoint.
 * @param {string} endpoint - The Sonarr API endpoint.
 * @returns {Promise<Object|Array|null>} The cached data, or null if not found.
 */
async function getSonarrCache (endpoint) {
  const key = sonarrRedisKey(endpoint);
  const cached = await redisClient.get(key);
  return cached ? JSON.parse(cached) : null;
}

const SONARR_API_KEY = process.env.SONARR_API_KEY;
const SONARR_URL = process.env.SONARR_URL || 'http://localhost:8989';

if (!SONARR_API_KEY) {
  throw new Error('SONARR_API_KEY environment variable is not set');
}

// Returns the API endpoint path for logging and request construction.
function buildUrl (path) {
  return SONARR_URL + path;
}

/**
 * Makes a Sonarr API request using native fetch and streams JSON responses for efficiency.
 * Handles endpoint, method, body, and error handling. Returns parsed JSON or text.
 * Throws on HTTP errors.
 *
 * @param {string} endpoint - API endpoint path (e.g., '/api/v3/series')
 * @param {string} [method='GET'] - HTTP method
 * @param {Object|null} [body=null] - Request body for POST/PUT
 * @returns {Promise<Object|Array|string>} Parsed JSON or text response
 */
async function sonarrRequest (endpoint, method = 'GET', body = null) {
  const url = buildUrl(endpoint);
  logger.info(`[Sonarr] Request: ${method} ${SONARR_URL}${endpoint}`);

  return streamJsonReq({
    url,
    method,
    headers: {
      'X-Api-Key': SONARR_API_KEY
    },
    body
  });
}

/**
 * Fetches all series from Sonarr, with Redis fallback for reliability.
 * Attempts to retrieve cached data first, then fetches from Sonarr API.
 * On success, updates the cache. On failure, falls back to cache if available.
 *
 * @returns {Promise<Array<Object>|null>} Array of series objects, or null if unavailable.
 */
export async function getSeries () {
  const endpoint = '/api/v3/series';
  let data = await getSonarrCache(endpoint);
  try {
    // Attempt live Sonarr API call
    const result = await sonarrRequest(endpoint);
    // Update cache on success
    await storeSonarrCache(endpoint, result);
    data = result;
  } catch (err) {
    // Log and fall back to cache
    logger.warn(`[Sonarr] GET ${endpoint} failed, using cached data if available: ${err.message}`);
  } finally {
    // Always return best available data
    return data;
  }
}

/**
 * Updates a series in Sonarr by ID.
 * Returns the updated series object.
 */
export async function updateSeries (seriesId, seriesData) {
  return sonarrRequest(`/api/v3/series/${seriesId}`, 'PUT', seriesData);
}

/**
 * Gets Sonarr system status info.
 */
export async function getSystemStatus () {
  return sonarrRequest('/api/v3/system/status');
}

/**
 * Fetches all tags from Sonarr, with Redis fallback for reliability.
 * Attempts to retrieve cached data first, then fetches from Sonarr API.
 * On success, updates the cache. On failure, falls back to cache if available.
 *
 * @returns {Promise<Array<Object>|null>} Array of tag objects, or null if unavailable.
 */
export async function getTags () {
  const endpoint = '/api/v3/tag';
  let data = await getSonarrCache(endpoint);
  try {
    const result = await sonarrRequest(endpoint);
    await storeSonarrCache(endpoint, result);
    data = result;
  } catch (err) {
    logger.warn(`[Sonarr] GET ${endpoint} failed, using cached data if available: ${err.message}`);
  } finally {
    return data;
  }
}

/**
 * Lists all episode files in a series by Sonarr series ID, with Redis fallback for reliability.
 * Attempts to retrieve cached data first, then fetches from Sonarr API.
 * On success, updates the cache. On failure, falls back to cache if available.
 *
 * @param {number|string} seriesId - The Sonarr series ID.
 * @returns {Promise<Array<Object>|null>} Array of episode file objects, or null if unavailable.
 */
export async function getEpisodeFiles (seriesId) {
  const endpoint = `/api/v3/episodefile?seriesId=${seriesId}`;
  let data = await getSonarrCache(endpoint);
  try {
    const result = await sonarrRequest(endpoint);
    await storeSonarrCache(endpoint, result);
    data = result;
  } catch (err) {
    logger.warn(`[Sonarr] GET ${endpoint} failed, using cached data if available: ${err.message}`);
  } finally {
    return data;
  }
}

/**
 * Lists all series with a specific tag (cached with lock/wait).
 * Uses Redis for 10-minute cache and lock/wait for concurrency.
 * Returns an array of series objects with the specified tag.
 * Throws if the tag is not found or API calls fail.
 */
export async function getSeriesByTag (tagName) {
  try {
    const cacheKey = `sonarr-tag-${tagName}`;
    const lockKey = `${cacheKey}-lock`;
    const cacheTtl = 600; // 10 minutes
    const lockTtl = 30; // 30 seconds

    const cached = await redisClient.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // Lock present? Wait for builder
    const gotLock = await redisClient.get(lockKey);
    if (gotLock) {
      let waited = 0;
      while (waited < lockTtl * 1000) {
        await delay(500);
        const cached2 = await redisClient.get(cacheKey);
        if (cached2) return JSON.parse(cached2);
        waited += 500;
      }
      throw new Error(`Timeout waiting for cache for tag '${tagName}'`);
    }

    // Acquire lock
    await redisClient.set(lockKey, 'locked', { EX: lockTtl });

    // Build cache: fetch all tags, find tag ID, filter series by tag
    const tags = await getTags();
    const tagObj = tags.find((t) => t.label === tagName);
    if (!tagObj) {
      await redisClient.del(lockKey);
      throw new Error(`Sonarr getSeriesByTag: tag '${tagName}' not found`);
    }
    const tagId = tagObj.id;

    const series = await getSeries();
    const result = series.filter(
      (s) => Array.isArray(s.tags) && s.tags.includes(tagId)
    );

    await redisClient.set(cacheKey, JSON.stringify(result), { EX: cacheTtl });
    await redisClient.del(lockKey);
    return result;
  } catch (err) {
    logger.error(
      `Sonarr getSeriesByTag: error fetching tag '${tagName}': ${err.message}`
    );
    throw err;
  }
}

/**
 * Gets all episode files for all series matching a tag.
 * Uses async.eachSeries for sequential async processing to avoid overloading the server.
 * Returns a flat array of all episode files found.
 * Throws if the tag is not found or API calls fail.
 */
export async function getEpisodeFilesByTag (tagName) {
  const seriesList = await getSeriesByTag(tagName);
  const allFiles = [];
  await async.eachSeries(
    seriesList,
    asyncify(async (series) => {
      try {
        const files = await getEpisodeFiles(series.id);
        allFiles.push(...files);
      } catch (err) {
        logger.error(
          `Sonarr getEpisodeFilesByTag: error fetching files for series ID ${series.id}: ${err.message}`
        );
      } finally {
        return true;
      }
    })
  );
  return allFiles;
}
