import fs from 'fs';
import logger from './logger';
import config from './config';
import File from '../models/files';

const { encode_version } = config;

export default async function generate_filelist ({ limit = 1, writeToFile = false }) {
  logger.info('GENERATING PRIMARY FILE LIST');
  // query for any files that have an encode version that doesn't match the current encode version
  // do not hydrate results into models
  // sort by priority, then size, then width
  const filelist = await File.find({
    encode_version: { $ne: encode_version },
    status: 'pending',
    $or: [{ 'lock.transcode': { $exists: false } }, { 'lock.transcode': null }, { 'lock.transcode': { $lt: new Date() } }] // exclude files that have a lock for integrity check
  })
    .sort({
      'sortFields.priority': 1,
      'sortFields.size': -1,
      'sortFields.width': -1
    })
    .limit(limit + config.concurrent_transcodes);

  if (writeToFile) {
    fs.writeFileSync(
      './output/filelist.json',
      JSON.stringify(
        filelist.slice(1, 1001).map((f) => ({
          path: f.path.split(/\//).pop(),
          size: f.sortFields.size,
          priority: f.sortFields.priority,
          resolution:
          f.probe.streams.find((v) => v.codec_type === 'video').width * 0.5625, // use width at 56.25% to calculate resolution
          codec: `${
          f.probe.streams.find((v) => v.codec_type === 'video')?.codec_name
        }/${f.probe.streams.find((v) => v.codec_type === 'audio')?.codec_name}`,
          encode_version: f.encode_version,
          computeScore: f.computeScore
        }))
      )
    );
  }

  // send back full list
  return filelist;
}
