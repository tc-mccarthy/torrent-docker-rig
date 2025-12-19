import { setTimeout as delay } from 'timers/promises';
import integrityCheck from './integrityCheck';
import logger from './logger';
import generate_integrity_filelist from './generate_integrity_filelist';

/**
 * @fileoverview IntegrityQueue schedules and runs integrity checks with a compute budget.
 *
 * Key memory design:
 * - The scheduler polls frequently (default every 2s).
 * - We keep `runningJobs` SMALL (summary objects only).
 * - We fetch lean scheduler candidates (no large `probe` blobs).
 * - When a job is executed, integrityCheck() loads the full Mongoose document by _id.
 */

/**
 * Minimal in-memory representation of a running job.
 * @typedef {Object} RunningJobSummary
 * @property {string} id Mongo _id as string.
 * @property {string} path File path (for logs/UI).
 * @property {number} computeScore Compute units reserved for this job.
 * @property {number} startedAtMs Epoch millis when the job started.
 */

export default class IntegrityQueue {
  /**
   * @param {Object} opts
   * @param {number} [opts.maxScore=4] Max compute units allowed simultaneously.
   * @param {number} [opts.pollDelay=2000] Delay between scheduling attempts (ms).
   */
  constructor ({ maxScore = 4, pollDelay = 2000 }) {
    logger.debug(`Initiating integrity check queue for a max compute of ${maxScore}...`);
    this.maxScore = maxScore;
    this.pollDelay = pollDelay;

    /** @type {RunningJobSummary[]} */
    this.runningJobs = [];

    this._isRunning = false;
  }

  /**
   * Start the integrity queue main loop.
   * This method returns when the loop is stopped.
   */
  async start () {
    this._isRunning = true;
    await this.loop();
  }

  /** Stop the queue. */
  stop () {
    this._isRunning = false;
    console.log('Integrity queue stopped.');
  }

  /** @returns {number} total compute currently in use. */
  getUsedCompute () {
    return this.runningJobs.reduce((sum, job) => sum + (job.computeScore || 0), 0);
  }

  /** @returns {number} compute capacity still available. */
  getAvailableCompute () {
    return this.maxScore - this.getUsedCompute();
  }

  /**
   * Main loop: schedule jobs then sleep.
   * Uses `delay()` which is cancellable if you stop the loop.
   */
  async loop () {
    while (this._isRunning) {
      await this.scheduleJobs();
      await delay(this.pollDelay);
    }
  }

  /**
   * Attempts to find and run a job that fits in the available compute budget.
   *
   * Implementation details:
   * - We exclude already-running job IDs at query time.
   * - We only keep small job summaries in memory.
   */
  async scheduleJobs () {
    const availableCompute = this.getAvailableCompute();

    // Exclude running IDs in the DB query so we don't keep re-fetching them.
    const excludeIds = this.runningJobs.map((j) => j.id);

    // Fetch lean candidates (minimal projection).
    const jobs = await generate_integrity_filelist({ limit: 50, excludeIds });

    // Are there any jobs being blocked due to lack of compute?
    const blockedHighPriorityJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j.id === job._id.toString());
      return !alreadyRunning && job.computeScore > availableCompute;
    });

    // Find the next job that fits within available compute.
    const nextJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j.id === job._id.toString());
      if (alreadyRunning || job.computeScore > availableCompute) return false;

      // If a higher-priority job is blocked, only schedule this job if it won't
      // prevent the blocked job from running later.
      if (blockedHighPriorityJob) {
        return (job.computeScore + blockedHighPriorityJob.computeScore) <= this.maxScore;
      }

      return true;
    });

    if (!nextJob) return;

    // Fire-and-forget. We track completion via cleanup in runJob().
    // NOTE: scheduleJobs continues polling, but excludeIds prevents duplicates.
    this.runJob(nextJob).catch((err) => {
      logger.error(err, { label: 'Integrity job failed (runJob)' });
    });
  }

  /**
   * Executes a single integrity job and updates in-memory running job state.
   *
   * @param {{_id:any, path:string, computeScore:number}} job Lean job candidate.
   */
  async runJob (job) {
    const id = job._id.toString();

    // Keep only a tiny summary object in memory to avoid retaining large docs.
    /** @type {RunningJobSummary} */
    const summary = {
      id,
      path: job.path,
      computeScore: job.computeScore,
      startedAtMs: Date.now()
    };

    this.runningJobs.push(summary);

    try {
      // integrityCheck() will load the full Mongoose doc by _id.
      await integrityCheck(job);
    } catch (err) {
      console.error(err);
    } finally {
      // Always clean up the running job entry.
      this.runningJobs = this.runningJobs.filter((j) => j.id !== id);
    }
  }
}
