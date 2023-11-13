/**
 * Generates the appropriate mongo connection string by environment
 *
 * mongodb://[username:password@]host1[:port1][,...hostN[:portN]][/[defaultauthdb][?options]]
 */

import mongoose from "mongoose";

export default function mongo_connect() {
  return mongoose.connect("mongodb://torrent-mongo-local/transcode", {
    maxPoolSize: 25,
    useNewUrlParser: true,
    useUnifiedTopology: true, // False by default. Set to true to opt in to using the MongoDB driver's new connection management engine. You should set this option to true, except for the unlikely case that it prevents you from maintaining a stable connection.
    socketTimeoutMS: 1000 * 60 * 10,
  });
}
