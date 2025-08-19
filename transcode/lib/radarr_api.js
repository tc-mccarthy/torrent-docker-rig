// radarr_api.js (streaming JSON, native fetch, ESModule)
//
// Radarr API client for Node.js 22+ using native fetch and stream-json for efficient large payload handling.
// All requests are streamed and parsed for minimal memory usage.
// Usage:
//   import { getMovies, updateMovie, getSystemStatus, getTags, getMoviesByTag, getMovieFiles, getMovieFilesByTag } from './radarr_api.js';
//   const movies = await getMovies();
//   await updateMovie(movieId, movieData);

import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'timers/promises';
import async, { asyncify } from 'async';
import { parser } from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray';
import { chain } from 'stream-chain';
import logger from './logger';
import memcached from './memcached';

const RADARR_API_KEY = process.env.RADARR_API_KEY;
const RADARR_URL = process.env.RADARR_URL || 'http://localhost:7878';

if (!RADARR_API_KEY) {
  throw new Error('RADARR_API_KEY environment variable is not set');
}

const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 50 });

// Returns the API endpoint path for logging and request construction.
function buildUrl (path) {
  return path;
}

/**
 * Makes a Radarr API request using native fetch and streams JSON responses for efficiency.
 * Handles endpoint, method, body, and error handling. Returns parsed JSON or text.
 * Throws on HTTP errors.
 *
 * @param {string} endpoint - API endpoint path (e.g., '/api/v3/movie')
 * @param {string} [method='GET'] - HTTP method
 * @param {Object|null} [body=null] - Request body for POST/PUT
 * @returns {Promise<Object|Array|string>} Parsed JSON or text response
 */
async function radarrRequest (endpoint, method = 'GET', body = null) {
  const url = buildUrl(endpoint);
  logger.info(`[Radarr] Request: ${method} ${RADARR_URL}${endpoint}`);

  const fetchOptions = {
    method,
    headers: {
      'X-Api-Key': RADARR_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Connection: 'close',
      'Accept-Encoding': 'gzip'
    },
    agent: url.startsWith('https') ? httpsAgent : httpAgent
  };
  if (body) {
    fetchOptions.body = JSON.stringify(body);
  }
  const response = await fetch(`${RADARR_URL}${endpoint}`, fetchOptions);
  if (!response.ok) {
    throw new Error(`RadarrRequest failed: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!/application\/json/i.test(contentType)) {
    return response.text();
  }
  // Stream and parse large JSON array/object efficiently
  return new Promise((resolve, reject) => {
    const result = {};
    let isArray = false;
    const items = [];
    const pipeline = chain([
      response.body,
      parser(),
      (data) => {
        if (!isArray && data.name === 'startArray') {
          isArray = true;
          return streamArray();
        }
        return data;
      }
    ]);
    pipeline.on('data', (data) => {
      if (isArray) {
        items.push(data.value);
      } else if (data.name === 'keyValue') {
        result[data.key] = data.value;
      }
    });
    pipeline.on('end', () => resolve(isArray ? items : result));
    pipeline.on('error', reject);
  });
}

/**
 * Fetches all movies from Radarr.
 * Returns an array of movie objects.
 */
export async function getMovies () {
  return radarrRequest('/api/v3/movie');
}

/**
 * Updates a movie in Radarr by ID.
 * Returns the updated movie object.
 */
export async function updateMovie (movieId, movieData) {
  return radarrRequest(`/api/v3/movie/${movieId}`, 'PUT', movieData);
}

/**
 * Gets Radarr system status info.
 */
export async function getSystemStatus () {
  return radarrRequest('/api/v3/system/status');
}

/**
 * Fetches all tags from Radarr.
 * Returns an array of tag objects.
 */
export async function getTags () {
  return radarrRequest('/api/v3/tag');
}

/**
 * Lists all files in a movie by Radarr movie ID.
 * Returns an array of file objects for the movie.
 */
export async function getMovieFiles (movieId) {
  return radarrRequest(`/api/v3/moviefile?movieId=${movieId}`);
}

/**
 * Lists all movies with a specific tag (cached with lock/wait).
 * Uses memcached for 10-minute cache and lock/wait for concurrency.
 * Returns an array of movie objects with the specified tag.
 * Throws if the tag is not found or API calls fail.
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
 * Gets all movie files for all movies matching a tag.
 * Uses async.eachSeries for sequential async processing to avoid overloading the server.
 * Returns a flat array of all movie files found.
 * Throws if the tag is not found or API calls fail.
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
