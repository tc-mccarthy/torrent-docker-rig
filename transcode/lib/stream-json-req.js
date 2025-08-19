// stream-json-req.js
// Utility for streaming and parsing large JSON HTTP responses efficiently using native fetch and stream-json.
// Handles both root-level arrays and objects, returning the correct structure.

import http from 'node:http';
import https from 'node:https';
import { parser } from 'stream-json';
import { chain } from 'stream-chain';
import { streamValues } from 'stream-json/streamers/StreamValues';
import logger from './logger';

const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 50 });

/**
 * Streams and parses a JSON HTTP response efficiently, handling both arrays and objects.
 * Uses stream-json to tokenize and emit values as they arrive, minimizing memory usage.
 *
 * @param {Object} options - Request options
 * @param {string} options.url - The full URL to request
 * @param {string} [options.method='GET'] - HTTP method (GET, POST, etc.)
 * @param {Object} [options.headers={}] - Additional headers to send
 * @param {Object|boolean} [options.body=false] - Request body (object for POST/PUT, false for none)
 * @returns {Promise<Object|Array|string>} Parsed JSON object, array, or text response
 * @throws {Error} If the request fails or response is not OK
 */
export default async function streamJsonReq ({ url, method = 'GET', headers = {}, body = false }) {
  // Build fetch options, including agents for keepalive and custom headers
  const fetchOptions = {
    method,
    headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
    agent: url.startsWith('https') ? httpsAgent : httpAgent
  };
  // Only set body if provided (for POST/PUT)
  if (body) fetchOptions.body = JSON.stringify(body);

  // Make the HTTP request using native fetch
  const response = await fetch(url, fetchOptions);
  if (!response.ok) {
    // Throw on HTTP error status
    throw new Error(`streamJsonReq failed: ${response.status} ${response.statusText}`);
  }

  // If not JSON, return as text (for error pages, etc.)
  const contentType = response.headers.get('content-type') || '';
  if (!/application\/json/i.test(contentType)) {
    return response.text();
  }

  // Stream and parse JSON efficiently, handling both arrays and objects
  // streamValues emits { key, value } for each item in the root array or object
  return new Promise((resolve, reject) => {
    let isArray = null; // Will be set based on first key type
    const items = [];
    const obj = {};

    // Set up the streaming pipeline
    const pipeline = chain([
      response.body, // Node.js Readable stream
      parser(), // Tokenizes JSON
      streamValues() // Emits { key, value } for both arrays and objects
    ]);

    pipeline.on('data', ({ key, value }) => {
      // Log each parsed key/value for debugging
      logger.info(`streamJsonReq: Parsed key=${key}, value=${typeof value}`, {
        label: 'PIPELINE JSON PARSE'
      });
      // Decide if root is array or object based on first key type
      if (isArray === null) {
        // Numeric keys mean array, string keys mean object
        isArray = typeof key === 'number';
      }
      if (isArray) items.push(value);
      else obj[key] = value;
    });

    pipeline.on('end', () => resolve(isArray ? items : obj));
    pipeline.on('error', reject);
  });
}
