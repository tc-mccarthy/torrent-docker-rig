import logger from './logger';
import File from '../models/files';

/**
 * @fileoverview Generates a prioritized list of files that need integrity checks.
 *
 * Why this exists:
 * - The integrity queue polls frequently.
 * - Loading full Mongoose documents (especially with large fields like `probe`)
 *   creates heavy heap churn and can look like a memory leak.
 *
 * This helper intentionally returns SMALL, plain JavaScript objects (via `.lean()`)
 * with a tight projection so the scheduler can make decisions without pulling
 * megabytes of data into memory.
 *
 * When a job is actually executed, we re-load the full Mongoose document by _id
 * inside `integrityCheck()` (one at a time), which is cheap and safe.
 */

/**
 * Builds a lean file list for integrity checks.
 *
 * @param {Object|number} [opts] Options or a numeric limit (backward compatible).
 * @param {number} [opts.limit=1000] Maximum number of candidates to return.
 * @param {string[]} [opts.excludeIds] Optional list of _id strings to exclude (e.g., running jobs).
 * @returns {Promise<Array<Object>>} Lean objects containing only scheduler-needed fields.
 */
export default async function generate_integrity_filelist (opts = {}) {
  // Backward compatibility: generate_integrity_filelist(50)
  const normalized = (typeof opts === 'number')
    ? { limit: opts }
    : (opts || {});

  const {
    limit = 1000,
    excludeIds = []
  } = normalized;

  logger.debug({ limit }, 'GENERATING INTEGRITY FILE LIST');

  // Only return the minimal fields needed by the scheduler/runner:
  // - _id: to load the full doc later
  // - path: to display/log / pass to the runner
  // - computeScore: to fit into available compute
  const projection = {
    _id: 1,
    path: 1,
    computeScore: 1
  };

  const query = {
    status: 'pending',
    integrityCheck: false
  };

  if (excludeIds.length > 0) {
    query._id = { $nin: excludeIds };
  }

  // IMPORTANT:
  // - `.lean()` avoids hydrating Mongoose documents (reduces memory usage).
  // - `.select(projection)` avoids pulling large fields like `probe`.
  const filelist = await File.find(query)
    .select(projection)
    .sort({
      'sortFields.priority': 1,
      'sortFields.size': 1,
      'sortFields.width': -1
    })
    .limit(limit)
    .lean()
    .exec();

  return filelist;
}
