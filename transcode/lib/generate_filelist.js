/**
 * @fileoverview
 * Builds a prioritized list of files that still need transcoding.
 *
 * IMPORTANT PERFORMANCE NOTE
 * --------------------------
 * The `files` collection documents can be very large (notably the `probe` payload).
 * This helper intentionally returns a *small* projection (lean objects) by default
 * so the scheduler can poll frequently without ballooning the Node/V8 heap.
 *
 * When `writeToFile` is enabled, we fetch a *minimal* subset of `probe.streams`
 * (video/audio codec + width) for human-readable output, rather than loading the
 * entire `probe` object.
 */

import fs from 'fs';
import path from 'path';
import logger from './logger';
import config from './config';
import File from '../models/files';
import dayjs from './dayjs';

const { encode_version } = config;

/**
 * Projection used for the scheduler loop. Keep this tiny.
 * @type {string}
 */
const SCHEDULER_SELECT =
  'path sortFields encode_version status computeScore integrityCheck permitHWDecode';

/**
 * Projection used only when writing output/filelist.json. Still avoids loading full probe.
 * @type {string}
 */
const FILE_OUTPUT_SELECT =
  `${SCHEDULER_SELECT} probe.streams.codec_type probe.streams.codec_name probe.streams.width`;

/**
 * Generates a prioritized list of files pending transcoding.
 *
 * @param {object} params
 * @param {number} [params.limit=1] Max number of records to return.
 * @param {boolean} [params.writeToFile=false] If true, writes a human-readable summary to ./output/filelist.json.
 * @returns {Promise<object[]>} Lean objects containing only the fields needed by the scheduler.
 */
export default async function generate_filelist ({ limit = 1, writeToFile = false }) {
  logger.debug('GENERATING PRIMARY FILE LIST');

  // NOTE: runningJobs is intentionally small (see transcodeQueue patch). We exclude those IDs
  // to avoid picking the same job twice during tight polling loops.
  const runningJobIds =
    global.transcodeQueue?.runningJobs?.map((f) => f._id?.toString()).filter(Boolean) || [];

  // Base query:
  // - pending work only
  // - encode_version mismatch
  // - must have passed integrity check
  // - exclude currently running jobs
  const query = {
    encode_version: { $ne: encode_version },
    status: 'pending',
    integrityCheck: true,
    ...(runningJobIds.length ? { _id: { $nin: runningJobIds } } : {})
  };

  // Always return a lean, projected set for scheduler stability.
  const select = writeToFile ? FILE_OUTPUT_SELECT : SCHEDULER_SELECT;

  const filelist = await File.find(query)
    .select(select)
    .sort({
      'sortFields.priority': 1,
      'sortFields.size': -1,
      'sortFields.width': -1
    })
    .limit(limit)
    .lean(); // critical: avoids hydration overhead & reduces heap churn

  if (writeToFile) {
    // Build a small summary (no giant probe dumps).
    const data = filelist.map((f) => {
      const p = f.path || '';
      const basename = p.split(/\//).pop();
      const volume = p.split(/\//)[2];

      const v = f.probe?.streams?.find((s) => s.codec_type === 'video');
      const a = f.probe?.streams?.find((s) => s.codec_type === 'audio');

      return {
        path: basename,
        volume,
        size: f.sortFields?.size,
        priority: f.sortFields?.priority,
        // Historically you used width*0.5625 as a "resolution-ish" scalar.
        // Keep the same behavior if width is available.
        resolution: v?.width ? v.width * 0.5625 : undefined,
        codec: `${v?.codec_name || 'unknown'}/${a?.codec_name || 'unknown'}`,
        encode_version: f.encode_version,
        computeScore: f.computeScore
      };
    });

    const outPath = path.resolve('./output/filelist.json');
    try {
      // Ensure output dir exists
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(
        outPath,
        JSON.stringify({ data, refreshed: dayjs().utc().local().format('MM-DD-YYYY HH:mm:ss') })
      );
    } catch (e) {
      logger.error(e, { label: 'FILELIST WRITE FAILURE' });
    }
  }

  return filelist;
}
