import { createClient } from 'redis';

const redisClient = createClient({ url: 'redis://torrent-redis-local' });

export default redisClient;
