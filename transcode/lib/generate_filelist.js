import fs from 'fs';
import mongoose from 'mongoose';
import logger from './logger';
// import config from './config';
import File from '../models/files';
import dayjs from './dayjs';

// const { encode_version } = config;

export default async function generate_filelist ({ limit = 1, writeToFile = false }) {
  logger.debug('GENERATING PRIMARY FILE LIST');
  // query for any files that have an encode version that doesn't match the current encode version
  // do not hydrate results into models
  // sort by priority, then size, then width
  // IMPORTANT:
  // This function is called frequently by the scheduler. To preserve memory
  // headroom for ffmpeg, we MUST avoid pulling full Mongo documents (especially
  // the large `probe` payload) into Node/V8 on each poll.
  //
  // Strategy:
  // - Use a projection to fetch only the fields required for scheduling.
  // - Use `.lean()` so results are plain objects (no Mongoose hydration).
  // - When writeToFile=true, include only the small probe stream subfields
  //   needed for codec/resolution reporting.

  const projection = {
    path: 1,
    encode_version: 1,
    status: 1,
    integrityCheck: 1,
    computeScore: 1,
    sortFields: 1,
    // Only include the small stream fields needed for the human-readable filelist.
    ...(writeToFile
      ? { 'probe.streams.codec_type': 1, 'probe.streams.codec_name': 1, 'probe.streams.width': 1 }
      : {})
  };

  const filelist = await File.find({
    status: 'pending',
    _id: { $nin: global.transcodeQueue?.runningJobs?.map((f) => new mongoose.Types.ObjectId(f._id.toString())) || [] },
    integrityCheck: true // only include files that have passed integrity check
  })
    .select(projection)
    .sort({
      'sortFields.priority': 1,
      'sortFields.size': -1,
      'sortFields.width': -1
    })
    .limit(limit)
    .lean();

  if (writeToFile) {
    const data = filelist.map((f) => {
      const videoStream = f.probe?.streams?.find((v) => v.codec_type === 'video');
      const audioStream = f.probe?.streams?.find((v) => v.codec_type === 'audio');

      return {
        path: f.path.split(/\//).pop(),
        volume: f.path.split(/\//)[2],
        size: f.sortFields.size,
        priority: f.sortFields.priority,
        resolution:
          (videoStream?.width || 0) * 0.5625, // use width at 56.25% to calculate resolution
        codec: `${videoStream?.codec_name || 'unknown'}/${audioStream?.codec_name || 'unknown'}`,
        encode_version: f.encode_version,
        computeScore: f.computeScore
      };
    });
    fs.writeFileSync(
      './output/filelist.json',
      JSON.stringify({ data, refreshed: dayjs().utc().local().format('MM-DD-YYYY HH:mm:ss') })
    );
  }

  // send back full list
  return filelist;
}
