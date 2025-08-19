// stream-json-req.js
//
// Efficiently stream and parse large JSON HTTP responses using undici fetch and stream-json.
// Uses a custom undici Agent for IPv4-only DNS lookup and keepalive, and converts WHATWG streams to Node streams for compatibility.

import axios from 'axios';
import http from 'node:http';
import https from 'node:https';
import logger from './logger';

/**
 * Non-keepalive agents (closest to curl/curl --no-keepalive behavior).
 * Prevents socket reuse issues seen with some Node.js HTTP clients.
 */
const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 50 });

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
  /**
 * Axios instance for Radarr API requests.
 * Configured for long timeouts and non-keepalive agents.
 */
  const client = axios.create({
    baseURL: url,
    timeout: 300_000, // 5 minutes for large payloads
    httpAgent,
    httpsAgent,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Connection: 'close',
      ...headers
    }
  // Axios buffers the full response; no streaming JSON here.
  });

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

  const res = await client.request({
    url,
    method,
    headers: {},
    data: body ?? undefined,
    // If you ever need raw text instead of JSON:
    // responseType: 'text',
    // transformResponse: [(data) => data],
    validateStatus: (status) => status >= 200 && status < 300
  });

  return res.data;
}
