// stream-json-req.js
//
// Efficiently stream and parse large JSON HTTP responses using undici fetch and stream-json.
// Uses a custom undici Agent for IPv4-only DNS lookup and keepalive, and converts WHATWG streams to Node streams for compatibility.

import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';
import { Readable } from 'node:stream';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { streamValues } from 'stream-json/streamers/StreamValues';
import logger from './logger';


// Create a single undici Agent for all requests (handles both HTTP and HTTPS).
const agent = new Agent({
  keepAliveTimeout: 30_000, // Keep connections alive for 30s
  keepAliveMaxTimeout: 60_000, // Max keepalive duration
});

// Set the global undici dispatcher so all fetches use our custom agent.
setGlobalDispatcher(agent);

/**
 * Streams and parses a large JSON HTTP response efficiently using undici fetch and stream-json.
 * Handles both root-level arrays and objects, returning the correct structure.
 * Converts WHATWG ReadableStream to Node.js Readable for compatibility with stream-json.
 * Logs timing and progress for observability.
 *
 * @param {Object} options - Request options
 * @param {string} options.url - The full URL to request
 * @param {string} [options.method='GET'] - HTTP method (GET, POST, etc.)
 * @param {Object} [options.headers={}] - Additional headers to send
 * @param {Object|boolean} [options.body=false] - Request body (object for POST/PUT, false for none)
 * @returns {Promise<Object|Array|string>} Parsed JSON object, array, or text response
 * @throws {Error} If the request fails or response is not OK
 */
export default async function streamJsonReq ({
  url,
  method = 'GET',
  headers = {},
  body = false
}) {
  // Build fetch options, including dispatcher for custom agent and timeout signal
  const fetchOptions = {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...headers
    },
    signal: AbortSignal.timeout(600_000), // Hard timeout for fetch
    dispatcher: agent // undici uses 'dispatcher' instead of 'agent'
  };
  // Only set body if provided (for POST/PUT)
  if (body) fetchOptions.body = JSON.stringify(body);

  // Track timing for request and header receipt
  const t0 = Date.now();
  const response = await undiciFetch(url, fetchOptions);
  const t1 = Date.now();
  logger.info(`streamJsonReq: headers in ${t1 - t0} ms`);

  // Throw on HTTP error status
  if (!response.ok) {
    throw new Error(`streamJsonReq failed: ${response.status} ${response.statusText}`);
  }

  // If not JSON, return as text (for error pages, etc.)
  const contentType = response.headers.get('content-type') || '';
  if (!/application\/json/i.test(contentType)) {
    return response.text();
  }

  // Convert WHATWG ReadableStream to Node.js Readable for stream-json compatibility
  const nodeStream = Readable.fromWeb(response.body);

  // Stream and parse JSON efficiently, handling both arrays and objects
  // streamValues emits { key, value } for each item in the root array or object
  return new Promise((resolve, reject) => {
    let isArray = null; // Will be set based on first key type
    const items = [];
    const obj = {};

    // Set up the streaming pipeline
    const pipeline = chain([
      nodeStream,
      parser(),
      streamValues()
    ]);

    // Log progress every 1000 items for observability
    let count = 0;
    pipeline.on('data', ({ key, value }) => {
      if (isArray === null) isArray = typeof key === 'number';
      if (isArray) items.push(value);
      else obj[key] = value;

      count += 1;
      if (count % 1000 === 0) {
        logger.info(`streamJsonReq: parsed ${count} items so far`);
      }
    });

    pipeline.once('end', () => {
      const t2 = Date.now();
      logger.info(`streamJsonReq: done in ${t2 - t1} ms after headers; total ${t2 - t0} ms`);
      resolve(isArray ? items : obj);
    });
    pipeline.once('error', reject);
  });
}
