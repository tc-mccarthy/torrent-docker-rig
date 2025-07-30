/**
 * TranscodeQueue
 * A smart queue for transcoding video jobs based on available compute (memory-oriented score),
 * with starvation protection to ensure large jobs aren't permanently blocked when compute is tight.
 */

import { setTimeout as delay } from 'timers/promises';
import fs from 'fs/promises';
import si from 'systeminformation'; // For system resource monitoring
import transcode from './transcode';
import logger from './logger';
import generate_filelist from './generate_filelist';

export default class TranscodeQueue {
  /**
   * Create a new TranscodeQueue.
   * @param {Object} options - Queue options
   * @param {number} options.maxScore - Maximum compute score available (memory-based)
   * @param {number} options.pollDelay - Delay between queue polls in ms
   */
  constructor ({ maxScore = 4, pollDelay = 2000 }) {
    logger.debug(`Initiating transcode queue for a max compute of ${maxScore}...`);
    this.maxScore = maxScore;
    this.computePenalty = 0; // Dynamically adjusted penalty based on system memory usage
    this.pollDelay = pollDelay;
    this.runningJobs = []; // Jobs currently being transcoded
    this._isRunning = false;

    // Memory pressure tracking (rolling average over 10 minutes)
    this.memoryPollIntervalMs = 5000;
    this.memoryUsageSamples = [];
    this.maxMemorySamples = 10 * 60 * 1000 / this.memoryPollIntervalMs;

    // Periodically flush the active queue state to disk
    this.flushIntervalMs = 10000;
    this.flushPath = '/usr/app/output/active.json';

    // Starvation tracking (used for fairness to large jobs)
    this.starvationCounter = 0;
    this.lastBlockedJobId = null;
  }

  /**
   * Start the queue scheduler loop and resource monitors.
   */
  async start () {
    if (this._isRunning) return;
    this._isRunning = true;
    logger.debug('Transcode queue started.');
    this.startMemoryPressureMonitor();
    this.startFlushLoop();
    await this.loop();
  }

  /**
   * Stop the transcode queue.
   */
  stop () {
    this._isRunning = false;
    console.log('Transcode queue stopped.');
  }

  /**
   * Calculate the total compute currently in use.
   * @returns {number}
   */
  getUsedCompute () {
    return this.runningJobs.reduce((sum, job) => sum + (job.computeScore || 1), 0);
  }

  /**
   * Calculate how much compute remains available (after penalty).
   * @returns {number}
   */
  getAvailableCompute () {
    return this.maxScore - this.computePenalty - this.getUsedCompute();
  }

  /**
   * Main queue polling loop that attempts to start jobs.
   */
  async loop () {
    while (this._isRunning) {
      await this.scheduleJobs();
      await delay(this.pollDelay);
    }
  }

  /**
   * Monitor system memory pressure and apply dynamic penalty.
   * If average memory use > 85%, reduce usable compute.
   */
  async startMemoryPressureMonitor () {
    while (true) {
      try {
        const mem = await si.mem();
        this.memoryUsageSamples.push(mem.available);
        if (this.memoryUsageSamples.length > this.maxMemorySamples) {
          this.memoryUsageSamples.shift();
        }

        const avgAvailable = this.memoryUsageSamples.reduce((a, b) => a + b, 0) / this.memoryUsageSamples.length;
        const memUsedPercent = 100 - (avgAvailable / mem.total * 100);

        let penalty = 0;
        if (memUsedPercent > 85) penalty += this.maxScore / 2;
        if (memUsedPercent > 90) penalty += this.maxScore / 2;

        this.computePenalty = penalty;

        console.log(`[ResourceMonitor] Penalty: ${penalty.toFixed(2)} | Avg Mem Used: ${memUsedPercent.toFixed(1)}%`);
      } catch (err) {
        console.error('[ResourceMonitor] Error:', err);
      }

      await delay(this.memoryPollIntervalMs);
    }
  }

  /**
   * Attempt to schedule the next job in the queue that fits available compute.
   * Applies starvation protection and priority rules.
   */
  async scheduleJobs () {
    const availableCompute = this.getAvailableCompute();
    logger.debug(`Available transcode compute: ${availableCompute}.`);
    if (availableCompute <= 0) return;

    const jobs = await generate_filelist({ limit: 50 });

    // Track the first job blocked due to insufficient compute
    let blockedJob = null;
    for (const job of jobs) {
      const alreadyRunning = this.runningJobs.some(j => j._id.toString() === job._id.toString());
      if (alreadyRunning) continue;

      if (job.computeScore > availableCompute) {
        blockedJob = job;

        if (this.lastBlockedJobId?.toString() === job._id.toString()) {
          this.starvationCounter++;
        } else {
          this.lastBlockedJobId = job._id;
          this.starvationCounter = 1;
        }

        logger.debug(`[QUEUE] Blocked job ${job.path} (score=${job.computeScore}) | starvationCounter=${this.starvationCounter}`);
        break;
      }
    }

    if (!blockedJob) {
      this.starvationCounter = 0;
      this.lastBlockedJobId = null;
    }

    const nextJob = jobs.find(job => {
      const alreadyRunning = this.runningJobs.some(j => j._id.toString() === job._id.toString());
      if (alreadyRunning || job.computeScore > availableCompute) return false;

      // BLOCKING RULE 1: If a job is blocked, don't start any lower-priority jobs
      if (blockedJob && job.sortFields.priority > blockedJob.sortFields.priority) {
        logger.debug(`Skipping ${job.path} — lower priority than blocked job ${blockedJob.path}`);
        return false;
      }

      // BLOCKING RULE 2: If the blocked job is same priority, only allow 5 jobs to pass
      if (blockedJob && job.sortFields.priority === blockedJob.sortFields.priority && this.starvationCounter >= 5) {
        logger.debug(`Holding ${job.path} — same priority as blocked job ${blockedJob.path} and starvation threshold reached.`);
        return false;
      }

      // Otherwise, job is eligible to run
      return true;
    });

    if (nextJob) {
      this.runJob(nextJob);
    }
  }

  /**
   * Execute and monitor a transcode job.
   * @param {Object} job - A job document from MongoDB
   */
  async runJob (job) {
    try {
      this.runningJobs.push({ ...job.toObject(), file: job.path });
      await transcode(job);
    } catch (err) {
      console.error(`Transcoding failed for ${job.path}: ${err.message}`);
    } finally {
      this.runningJobs = this.runningJobs.filter(j => j._id.toString() !== job._id.toString());
      generate_filelist({ limit: 1000, writeToFile: true });
    }
  }

  /**
   * Periodically flush active queue state to a file for monitoring.
   *
   * This loop runs as long as the queue is active, writing the current job state
   * and compute metrics to disk every flushIntervalMs milliseconds. This enables
   * external monitoring and dashboard updates.
   */
  async startFlushLoop () {
    while (this._isRunning) {
      await this.flushActiveJobs();
      await delay(this.flushIntervalMs);
    }
  }

  /**
   * Write current job state and compute metrics to a JSON file for monitoring.
   *
   * The output includes:
   *   - active: Array of currently running jobs
   *   - availableCompute: Remaining compute slots after penalty and usage
   *   - computePenalty: Current penalty applied due to memory pressure
   *   - refreshed: Timestamp of last flush
   *
   * If writing fails, logs the error for troubleshooting.
   */
  async flushActiveJobs () {
    try {
      const flushObj = {
        active: this.runningJobs,
        availableCompute: this.getAvailableCompute(),
        computePenalty: this.computePenalty,
        refreshed: Date.now()
      };
      await fs.writeFile(this.flushPath, JSON.stringify(flushObj, null, 2));
    } catch (err) {
      logger.error('Failed to flush active jobs:', err);
    }
  }
}
