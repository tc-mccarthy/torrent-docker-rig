// Helper to build a Redis key for Radarr GET requests
// radarr_api.js (streaming JSON, native fetch, ESModule)
//
// Radarr API client for Node.js 22+ using native fetch and stream-json for efficient large payload handling.
// All requests are streamed and parsed for minimal memory usage.
// Usage:
//   import { getMovies, updateMovie, getSystemStatus, getTags, getMoviesByTag, getMovieFiles, getMovieFilesByTag } from './radarr_api.js';
//   const movies = await getMovies();
//   await updateMovie(movieId, movieData);

import { setTimeout as delay } from 'timers/promises';
import async, { asyncify } from 'async';
import logger from './logger';
import redisClient from './redis';
import streamJsonReq from './stream-json-req';

function radarrRedisKey (endpoint) {
  return `radarr:${endpoint}`;
}

// Store data in Redis for a given endpoint (no expiration)
async function storeRadarrCache (endpoint, data) {
  const key = radarrRedisKey(endpoint);
  await redisClient.set(key, JSON.stringify(data));
}

// Retrieve data from Redis for a given endpoint
async function getRadarrCache (endpoint) {
  const key = radarrRedisKey(endpoint);
  const cached = await redisClient.get(key);
  return cached ? JSON.parse(cached) : null;
}

const RADARR_API_KEY = process.env.RADARR_API_KEY;
const RADARR_URL = process.env.RADARR_URL || 'http://localhost:7878';

if (!RADARR_API_KEY) {
  throw new Error('RADARR_API_KEY environment variable is not set');
}

// Returns the API endpoint path for logging and request construction.
function buildUrl (path) {
  return RADARR_URL + path;
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

  return streamJsonReq({
    url,
    method,
    headers: {
      'X-Api-Key': RADARR_API_KEY
    }
  });
}

/**
 * Fetches all movies from Radarr, with Redis fallback for reliability.
 * Attempts to retrieve cached data first, then fetches from Radarr API.
 * On success, updates the cache. On failure, falls back to cache if available.
 *
 * @returns {Promise<Array<Object>|null>} Array of movie objects, or null if unavailable.
 */
export async function getMovies () {
  const endpoint = '/api/v3/movie';
  let data = await getRadarrCache(endpoint);
  try {
    // Attempt live Radarr API call
    const result = await radarrRequest(endpoint);
    // Update cache on success
    await storeRadarrCache(endpoint, result);
    data = result;
  } catch (err) {
    // Log and fall back to cache
    logger.warn(`[Radarr] GET ${endpoint} failed, using cached data if available: ${err.message}`);
  } finally {
    // Always return best available data
    return data;
  }
}

/**
 * Updates a movie in Radarr by ID.
 *
 * @param {number|string} movieId - The Radarr movie ID.
 * @param {Object} movieData - The movie data to update.
 * @returns {Promise<Object>} The updated movie object.
 */
export async function updateMovie (movieId, movieData) {
  return radarrRequest(`/api/v3/movie/${movieId}`, 'PUT', movieData);
}

/**
 * Gets Radarr system status info (no Redis fallback).
 *
 * @returns {Promise<Object>} The system status object.
 */
export async function getSystemStatus () {
  return radarrRequest('/api/v3/system/status');
}

/**
 * Fetches all tags from Radarr, with Redis fallback for reliability.
 * Attempts to retrieve cached data first, then fetches from Radarr API.
 * On success, updates the cache. On failure, falls back to cache if available.
 *
 * @returns {Promise<Array<Object>|null>} Array of tag objects, or null if unavailable.
 */
export async function getTags () {
  const endpoint = '/api/v3/tag';
  let data = await getRadarrCache(endpoint);
  try {
    const result = await radarrRequest(endpoint);
    await storeRadarrCache(endpoint, result);
    data = result;
  } catch (err) {
    logger.warn(`[Radarr] GET ${endpoint} failed, using cached data if available: ${err.message}`);
  } finally {
    return data;
  }
}

/**
 * Lists all files in a movie by Radarr movie ID, with Redis fallback for reliability.
 * Attempts to retrieve cached data first, then fetches from Radarr API.
 * On success, updates the cache. On failure, falls back to cache if available.
 *
 * @param {number|string} movieId - The Radarr movie ID.
 * @returns {Promise<Array<Object>|null>} Array of file objects, or null if unavailable.
 */
export async function getMovieFiles (movieId) {
  const endpoint = `/api/v3/moviefile?movieId=${movieId}`;
  let data = await getRadarrCache(endpoint);
  try {
    const result = await radarrRequest(endpoint);
    await storeRadarrCache(endpoint, result);
    data = result;
  } catch (err) {
    logger.warn(`[Radarr] GET ${endpoint} failed, using cached data if available: ${err.message}`);
  } finally {
    return data;
  }
}

/**
 * Lists all movies with a specific tag (cached with lock/wait).
 * Uses Redis for 10-minute cache and lock/wait for concurrency.
 * Returns an array of movie objects with the specified tag.
 * Throws if the tag is not found or API calls fail.
 */
export async function getMoviesByTag (tagName) {
  try {
    const cacheKey = `radarr-tag-${tagName}`;
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

    // Build cache: fetch all tags, find tag ID, filter movies by tag
    const tags = await getTags();
    const tagObj = tags.find((t) => t.label === tagName);
    if (!tagObj) {
      await redisClient.del(lockKey);
      throw new Error(`Radarr getMoviesByTag: tag '${tagName}' not found`);
    }
    const tagId = tagObj.id;

    const movies = await getMovies();
    const result = movies.filter(
      (m) => Array.isArray(m.tags) && m.tags.includes(tagId)
    );

    await redisClient.set(cacheKey, JSON.stringify(result), { EX: cacheTtl });
    await redisClient.del(lockKey);
    return result;
  } catch (err) {
    logger.error(
      `Radarr getMoviesByTag: error fetching tag '${tagName}': ${err.message}`
    );
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
        logger.error(
          `Radarr getMovieFilesByTag: error fetching files for movie ID ${movie.id}: ${err.message}`
        );
      } finally {
        return true;
      }
    })
  );
  return allFiles;
}
