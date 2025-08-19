// radarr_api.js (Axios refactor, ESModule)
/**
 * Radarr API Client (Axios, ESModule)
 *
 * Provides functions to interact with a Radarr server using its REST API.
 * Uses Axios for HTTP requests, with non-keepalive agents for reliability.
 * All functions throw on error and return parsed JSON responses.
 *
 * Usage:
 *   import { getMovies, updateMovie, getSystemStatus, getTags, getMoviesByTag, getMovieFiles, getMovieFilesByTag } from './radarr_api.js';
 *
 *   const movies = await getMovies();
 *   await updateMovie(movieId, movieData);
 */

import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'timers/promises';
import async, { asyncify } from 'async';
import memcached from './memcached';
import logger from './logger';

/**
 * Radarr API Client (Axios)
 */
const RADARR_API_KEY = process.env.RADARR_API_KEY;
const RADARR_URL = process.env.RADARR_URL || 'http://localhost:7878';

if (!RADARR_API_KEY) {
  throw new Error('RADARR_API_KEY environment variable is not set');
}

/**
 * Non-keepalive agents (closest to curl/curl --no-keepalive behavior).
 * Prevents socket reuse issues seen with some Node.js HTTP clients.
 */
const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 50 });

/**
 * Axios instance for Radarr API requests.
 * Configured for long timeouts and non-keepalive agents.
 */
const client = axios.create({
  baseURL: RADARR_URL,
  timeout: 300_000, // 5 minutes for large payloads
  httpAgent,
  httpsAgent,
  headers: {
    'X-Api-Key': RADARR_API_KEY,
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
      logger.warn(`[Radarr] transient error, retrying once: ${error.code || error.message}`);
      return client.request(cfg);
    }
    return Promise.reject(error);
  }
);

/**
 * Helper to build Radarr API URLs (for logging).
 * @param {string} path - API endpoint path (e.g., '/api/v3/movie')
 * @returns {string} API endpoint path (baseURL is already applied)
 */
function buildUrl (path) {
  return path;
}

/**
 * Helper to build headers for Radarr API requests.
 * @returns {Object} Headers for per-request overrides (default headers are set in Axios instance)
 */
function buildHeaders () {
  return {};
}

/**
 * Makes a Radarr API request using Axios.
 * Handles endpoint, method, body, and error handling.
 *
 * @param {string} endpoint - API endpoint path (e.g., '/api/v3/movie')
 * @param {string} [method='GET'] - HTTP method
 * @param {Object|null} [body=null] - Request body (for POST/PUT)
 * @returns {Promise<Object>} Parsed JSON response
 * @throws {Error} If the request fails or a socket error occurs
 */
async function radarrRequest (endpoint, method = 'GET', body = null) {
  const url = buildUrl(endpoint);
  logger.info(`[Radarr] Request: ${method} ${RADARR_URL}${endpoint}`);

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
 * Fetch movies from Radarr with optional pagination and caching.
 * @param {Object} [opts] - Options for pagination and caching
 * @param {number} [opts.page=1] - Page number (Radarr pages start at 1)
 * @param {number} [opts.pageSize=100] - Number of movies per page
 * @param {number} [opts.cacheTtl=0] - Cache TTL in seconds (0 disables cache)
 * @returns {Promise<Array>} Array of movie objects
 */
export async function getMovies (opts = {}) {
  const { pageSize = 100 } = opts;
  let page = 1;
  const allMovies = [];
  while (true) {
    const endpoint = `/api/v3/movie?page=${page}&pageSize=${pageSize}`;
    const movies = await radarrRequest(endpoint);
    if (!Array.isArray(movies) || movies.length === 0) break;
    allMovies.push(...movies);
    if (movies.length < pageSize) break;
    page += 1;
  }
  return allMovies;
}

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
export async function getSystemStatus () {
  return radarrRequest('/api/v3/system/status');
}

/**
 * Fetch all tags from Radarr.
 * @returns {Promise<Array>} Array of tag objects
 */
export async function getTags () {
  return radarrRequest('/api/v3/tag');
}

/**
 * List all files in a movie by movie ID.
 * @param {number} movieId - The Radarr movie ID
 * @returns {Promise<Array>} Array of file objects for the movie
 */
export async function getMovieFiles (movieId) {
  return radarrRequest(`/api/v3/moviefile?movieId=${movieId}`);
}

/**
 * List all movies with a specific tag (cached with lock/wait).
 * Uses memcached for 10-minute cache and lock/wait for concurrency.
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

    // Build cache: fetch all tags, find tag ID, filter movies by tag
    const tags = await getTags();
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
 * Get all movie files for all movies matching a tag.
 * Uses async.eachSeries for sequential async processing to avoid overloading the server.
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
