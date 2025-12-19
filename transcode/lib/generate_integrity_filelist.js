/**
 * @file generate_integrity_filelist.js
 * @description
 * Builds a list of candidate files for the integrity-check queue.
 *
 * This function can run frequently. For memory safety, it MUST return lean,
 * projected objects (not hydrated Mongoose docs and not the full `probe` blob).
 */

import logger from './logger';
import File from '../models/files';

/**
 * Generates a lean list of integrity-check candidates.
 *
 * @param {Object|number} args - Either a limit number (legacy) or an options object.
 * @param {number} [args.limit=1000] - Max number of jobs to return.
 * @returns {Promise<Array<{_id:any, path:string, computeScore:number, sortFields:Object}>>}
 */
export default async function generate_integrity_filelist (args = 1000) {
  const limit = typeof args === 'number' ? args : (args?.limit ?? 1000);
  logger.debug('GENERATING INTEGRITY FILE LIST');
  // query for any files that have an encode version that doesn't match the current encode version
  // do not hydrate results into models
  // sort by priority, then size, then width
  const filelist = await File.find({
    status: 'pending',
    integrityCheck: false,
    _id: { $not: { $in: global.integrityQueue?.runningJobs?.map((f) => f._id.toString()) || [] } }
  })
    // Projection is critical: the integrity scheduler does not need full docs.
    .select({ path: 1, computeScore: 1, sortFields: 1 })
    .sort({
      'sortFields.priority': 1,
      'sortFields.size': 1,
      'sortFields.width': -1
    })
    .limit(limit);

  // Lean prevents Mongoose hydration and reduces per-interval heap churn.
  return filelist.lean();
}
