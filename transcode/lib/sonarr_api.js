// sonarr_api.js (Axios refactor, ESModule)
/**
 * Sonarr API Client (Axios, ESModule)
 *
 * Provides functions to interact with a Sonarr server using its REST API.
 * Uses Axios for HTTP requests, with non-keepalive agents for reliability.
 * All functions throw on error and return parsed JSON responses.
 *
 * Usage:
 *   import { getSeries, updateSeries, getSystemStatus, getTags, getSeriesByTag, getEpisodeFiles, getEpisodeFilesByTag } from './sonarr_api.js';
 *
 *   const series = await getSeries();
 *   await updateSeries(seriesId, seriesData);
 */

import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'timers/promises';
import async, { asyncify } from 'async';
import memcached from './memcached';
import logger from './logger';

/**
 * Sonarr API Client (Axios)
 */
const SONARR_API_KEY = process.env.SONARR_API_KEY;
const SONARR_URL = process.env.SONARR_URL || 'http://localhost:8989';

if (!SONARR_API_KEY) {
  throw new Error('SONARR_API_KEY environment variable is not set');
}

/**
 * Non-keepalive agents (closest to curl/curl --no-keepalive behavior).
 * Prevents socket reuse issues seen with some Node.js HTTP clients.
 */
const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 50 });

/**
 * Axios instance for Sonarr API requests.
 * Configured for long timeouts and non-keepalive agents.
 */
const client = axios.create({
  baseURL: SONARR_URL,
  timeout: 300_000, // 5 minutes for large payloads
  httpAgent,
  httpsAgent,
  headers: {
    'X-Api-Key': SONARR_API_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Connection: 'close'
  }
  // Axios buffers the full response; no streaming JSON here.
});

/**
 * Detects transient socket errors for retry logic.
 * @param {Error} error - Error object from Axios
 * @returns {boolean} True if error is a transient socket error
 */
function isTransientSocketError (error) {
  const msg = String(error?.message || '');
  const code = String(error?.code || '');
  return (
    /UND_ERR_SOCKET|und_sock_err|socket|EAI_AGAIN/i.test(msg) ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT'
  );
}

/**
 * Axios one-shot retry interceptor for transient socket errors.
 * Retries once per request if a transient error is detected.
 */
client.interceptors.response.use(
  (res) => res,
  async (error) => {
    const cfg = error?.config || {};
    if (!cfg || cfg.__retryOnceDone) {
      return Promise.reject(error);
    }
    if (isTransientSocketError(error)) {
      cfg.__retryOnceDone = true;
      logger.warn(`[Sonarr] transient error, retrying once: ${error.code || error.message}`);
      return client.request(cfg);
    }
    return Promise.reject(error);
  }
);

/**
 * Helper to build Sonarr API URLs (for logging).
 * @param {string} path - API endpoint path (e.g., '/api/v3/series')
 * @returns {string} API endpoint path (baseURL is already applied)
 */
function buildUrl (path) {
  return path;
}

/**
 * Helper to build headers for Sonarr API requests.
 * @returns {Object} Headers for per-request overrides (default headers are set in Axios instance)
 */
function buildHeaders () {
  return {};
}

/**
 * Makes a Sonarr API request using Axios.
 * Handles endpoint, method, body, and error handling.
 *
 * @param {string} endpoint - API endpoint path (e.g., '/api/v3/series')
 * @param {string} [method='GET'] - HTTP method
 * @param {Object|null} [body=null] - Request body (for POST/PUT)
 * @returns {Promise<Object>} Parsed JSON response
 * @throws {Error} If the request fails or a socket error occurs
 */
async function sonarrRequest (endpoint, method = 'GET', body = null) {
  const url = buildUrl(endpoint);
  logger.info(`[Sonarr] Request: ${method} ${SONARR_URL}${endpoint}`);

  const res = await client.request({
    url,
    method,
    headers: buildHeaders(),
    data: body ?? undefined,
    // If you ever need raw text instead of JSON:
    // responseType: 'text',
    // transformResponse: [(data) => data],
    validateStatus: (status) => status >= 200 && status < 300
  });

  return res.data;
}

/**
 * Fetch all series from Sonarr.
 * @returns {Promise<Array>} Array of series objects
 */
export async function getSeries () {
  return sonarrRequest('/api/v3/series');
}

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
 * Get Sonarr system status.
 * @returns {Promise<Object>} System status info
 */
export async function getSystemStatus () {
  return sonarrRequest('/api/v3/system/status');
}

/**
 * Fetch all tags from Sonarr.
 * @returns {Promise<Array>} Array of tag objects
 */
export async function getTags () {
  return sonarrRequest('/api/v3/tag');
}

/**
 * List all episode files in a series by series ID.
 * @param {number} seriesId - The Sonarr series ID
 * @returns {Promise<Array>} Array of episode file objects for the series
 */
export async function getEpisodeFiles (seriesId) {
  return sonarrRequest(`/api/v3/episodefile?seriesId=${seriesId}`);
}

/**
 * List all series with a specific tag (cached with lock/wait).
 * Uses memcached for 10-minute cache and lock/wait for concurrency.
 *
 * @param {string} tagName - The tag value to filter by (case-sensitive)
 * @returns {Promise<Array>} Array of series objects with the specified tag
 * @throws {Error} If the tag is not found or API calls fail
 */
export async function getSeriesByTag (tagName) {
  try {
    const cacheKey = `sonarr-tag-${tagName}`;
    const lockKey = `${cacheKey}-lock`;
    const cacheTtl = 600; // 10 minutes
    const lockTtl = 30; // 30 seconds

    const cached = await memcached.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // Lock present? Wait for builder
    const gotLock = await memcached.get(lockKey);
    if (gotLock) {
      let waited = 0;
      while (waited < lockTtl * 1000) {
        await delay(500);
        const cached2 = await memcached.get(cacheKey);
        if (cached2) return JSON.parse(cached2);
        waited += 500;
      }
      throw new Error(`Timeout waiting for cache for tag '${tagName}'`);
    }

    // Acquire lock
    await memcached.set(lockKey, 'locked', lockTtl);

    // Build cache: fetch all tags, find tag ID, filter series by tag
    const tags = await getTags();
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
 * Get all episode files for all series matching a tag.
 * Uses async.eachSeries for sequential async processing to avoid overloading the server.
 * Returns a flat array of all episode files found.
 *
 * @param {string} tagName - The tag value to filter by (case-sensitive)
 * @returns {Promise<Array>} Array of episode file objects across all matching series
 * @throws {Error} If the tag is not found or API calls fail
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
        logger.error(`Sonarr getEpisodeFilesByTag: error fetching files for series ID ${series.id}: ${err.message}`);
      } finally {
        return true;
      }
    })
  );
  return allFiles;
}
