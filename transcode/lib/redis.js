
import { createClient } from 'redis';
import pkg from '../package.json';

// Define the Redis namespace for all keys
export const REDIS_NAMESPACE = `transcoder:${pkg.version}`;

const redisClient = createClient({ url: 'redis://torrent-redis-local' });

/**
 * Prefixes a key with the Redis namespace.
 * @param {string} key - The key to namespace.
 * @returns {string} Namespaced key.
 */
export function nsKey (key) {
  return `${REDIS_NAMESPACE}:${key}`;
}

export default redisClient;
