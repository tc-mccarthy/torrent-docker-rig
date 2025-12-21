
import fs from 'fs';
import mongoose from 'mongoose';
import logger from './logger';
import File from '../models/files';
import dayjs from './dayjs';

/**
 * Generates a prioritized file list for transcoding jobs.
 *
 * This function queries the database for files pending transcode, sorts and projects only the minimal fields
 * required for scheduling, and (optionally) writes a human-readable summary to disk. It is designed to be
 * memory-efficient and safe for frequent invocation by background schedulers.
 *
 * If writeToFile is true, the function will also write a summary to ./output/filelist.json and schedule itself
 * to run again in 5 minutes, ensuring the file list stays fresh. Timeout is cleared at invocation to prevent
 * overlapping runs if triggered early elsewhere.
 *
 * Args:
 *   limit (number, optional): Maximum number of files to include in the list. Defaults to 1.
 *   writeToFile (boolean, optional): Whether to write the file list to disk and schedule next run. Defaults to true.
 *
 * Returns:
 *   {Promise<Array<Object>>} The list of file objects matching the query and projection.
 */

export default async function generate_filelist ({
  limit = 1,
  writeToFile = true
}) {
  logger.debug('GENERATING PRIMARY FILE LIST');

  // If running as a scheduled task, clear any existing timeout to avoid overlap.
  if (global.fileListTimeout && writeToFile) {
    clearTimeout(global.fileListTimeout);
  }

  // Only fetch the fields required for scheduling and reporting.
  // When writing to file, include minimal probe stream info for summary.
  const projection = {
    path: 1,
    encode_version: 1,
    status: 1,
    integrityCheck: 1,
    computeScore: 1,
    sortFields: 1,
    ...(writeToFile
      ? {
        'probe.streams.codec_type': 1,
        'probe.streams.codec_name': 1,
        'probe.streams.width': 1
      }
      : {})
  };

  // Query for files that are pending transcode, not currently running, and have passed integrity check.
  // Use .lean() to avoid Mongoose hydration and save memory.
  const filelist = await File.find({
    status: 'pending',
    _id: {
      $nin:
        global.transcodeQueue?.runningJobs?.map(
          (f) => new mongoose.Types.ObjectId(f._id.toString())
        ) || []
    },
    integrityCheck: true // only include files that have passed integrity check
  })
    .select(projection)
    .sort({
      'sortFields.priority': 1, // prioritize by custom priority field (lower is higher priority)
      'sortFields.size': -1, // then by size (larger files first)
      'sortFields.width': -1 // then by width (higher resolution first)
    })
    .limit(limit)
    .lean();

  if (writeToFile) {
    // Prepare a summary for the filelist output file.
    // Only include minimal info for UI/reporting, not the full DB record.
    const data = filelist.map((f) => {
      // Extract the first video and audio stream for summary fields.
      const videoStream = f.probe?.streams?.find((v) => v.codec_type === 'video');
      const audioStream = f.probe?.streams?.find((v) => v.codec_type === 'audio');

      return {
        // Only the filename, not the full path
        path: f.path.split(/\//).pop(),
        // Volume is the third segment in the path (e.g. /mnt/volume/dir/file)
        volume: f.path.split(/\//)[2],
        size: f.sortFields.size,
        priority: f.sortFields.priority,
        // Calculate resolution as width * 0.5625 (approximate 16:9 height)
        resolution: (videoStream?.width || 0) * 0.5625,
        // Codec string as video/audio, fallback to 'unknown' if missing
        codec: `${videoStream?.codec_name || 'unknown'}/${audioStream?.codec_name || 'unknown'}`,
        encode_version: f.encode_version,
        computeScore: f.computeScore
      };
    });

    // Write the summary file to disk for UI or external use.
    fs.writeFileSync(
      './output/filelist.json',
      JSON.stringify({
        data,
        refreshed: dayjs().utc().local().format('MM-DD-YYYY HH:mm:ss')
      })
    );

    // Schedule the next run in 5 minutes (300,000 ms).
    // This ensures the filelist stays up to date even if not triggered elsewhere.
    global.fileListTimeout = setTimeout(() => {
      generate_filelist({ limit, writeToFile });
    }, 5 * 60 * 1000);
  }

  // Return the full list for programmatic use (not written to file)
  return filelist;
}
