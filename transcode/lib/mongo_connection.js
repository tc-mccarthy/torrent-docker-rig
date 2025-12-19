/**
 * Generates the appropriate mongo connection string by environment
 *
 * mongodb://[username:password@]host1[:port1][,...hostN[:portN]][/[defaultauthdb][?options]]
 */

import mongoose from 'mongoose';

// --- Global Mongoose defaults (memory + stability) ---
// Avoid buffering model operations when disconnected; buffering can hold
// references in memory and hide connection issues.
mongoose.set('bufferCommands', false);

// For service workloads, index creation should be handled out-of-band.
// Prevents surprise memory/CPU spikes at runtime.
mongoose.set('autoIndex', process.env.MONGOOSE_AUTO_INDEX === 'true');

// Encourage predictable query behavior.
mongoose.set('strictQuery', true);

export default function mongo_connect () {
  // Pool size impacts memory and file descriptor usage. Keep it reasonable
  // for a single-node service.
  const maxPoolSize = Number(process.env.MONGO_MAX_POOL_SIZE || 10);

  return mongoose.connect(process.env.MONGO_URI || 'mongodb://torrent-mongo-local/transcode', {
    maxPoolSize,
    // Close idle sockets to reduce background memory usage.
    maxIdleTimeMS: 60 * 1000,
    // Server selection timeout keeps startup failures fast and avoids long buffered work.
    serverSelectionTimeoutMS: 10 * 1000,
    socketTimeoutMS: 1000 * 60 * 10
  });
}
