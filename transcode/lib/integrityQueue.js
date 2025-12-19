import { setTimeout as delay } from 'timers/promises';
import integrityCheck from './integrityCheck';
import logger from './logger';
import generate_integrity_filelist from './generate_integrity_filelist';
import File from '../models/files';

export default class IntegrityQueue {
  constructor ({ maxScore = 4, pollDelay = 2000 }) {
    // start the integrity check loops
    logger.debug(`Initiating integrity check queue for a max compute of ${maxScore}...`);
    this.maxScore = maxScore; // Max compute units allowed simultaneously
    // Adaptive polling: back off when idle to reduce resource churn.
    this.basePollDelay = pollDelay;
    this.pollDelay = pollDelay; // Current delay between scheduling attempts (ms)
    this.maxPollDelay = 15000;
    this.runningJobs = []; // In-memory list of currently active jobs
    this._isRunning = false; // Flag for controlling the loop
  }

  // Starts the recursive scheduling loop
  async start () {
    if (this._isRunning) return;
    this._isRunning = true;
    logger.debug('Integrity check queue started.');
    await this.loop();
  }

  // Stops the queue
  stop () {
    this._isRunning = false;
    console.log('Integrity queue stopped.');
  }

  // Returns total compute in use
  getUsedCompute () {
    return this.runningJobs.reduce((sum, job) => sum + job.computeScore, 0);
  }

  // Returns available compute capacity
  getAvailableCompute () {
    return this.maxScore - this.getUsedCompute();
  }

  // Main loop: tries to schedule jobs and waits before the next run
  async loop () {
    while (this._isRunning) {
      const { scheduled, candidates } = await this.scheduleJobs();

      if (!candidates) {
        this.pollDelay = Math.min(Math.ceil(this.pollDelay * 1.5), this.maxPollDelay);
      } else if (scheduled) {
        this.pollDelay = this.basePollDelay;
      } else {
        this.pollDelay = Math.min(this.pollDelay, this.basePollDelay);
      }

      await delay(this.pollDelay);
    }
  }

  // Attempts to find and run a job that fits within available compute
  async scheduleJobs () {
    const availableCompute = this.getAvailableCompute();
    logger.debug(`Available integrity check compute: ${availableCompute}.`);

    if (availableCompute <= 0) return { scheduled: false, candidates: true };

    // IMPORTANT:
    // generate_integrity_filelist returns lean, projected jobs.
    const jobs = await generate_integrity_filelist({ limit: 50 });
    if (!jobs || jobs.length === 0) return { scheduled: false, candidates: false };

    // Are there any jobs being blocked due to lack of compute?
    const blockedHighPriorityJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j._id.toString() === job._id.toString());
      return !alreadyRunning && job.computeScore > availableCompute;
    });

    // Now let's find the next job that will fit within available compute
    const nextJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j._id.toString() === job._id.toString()); // skip any already running jobs
      if (alreadyRunning || job.computeScore > availableCompute) return false; // discount any jobs that are already running or exceed available compute

      // If a higher-priority job is blocked, don't schedule lower-priority jobs
      if (blockedHighPriorityJob && job.sortFields.priority > blockedHighPriorityJob.sortFields.priority) return false; // if a higher-priority job is blocked, don't schedule lower-priority jobs, let the queue open up to process the higher-priority job

      // If we reach here, the job is eligible to run
      return true;
    });

    if (nextJob) {
      this.runJob(nextJob);
      return { scheduled: true, candidates: true };
    }

    return { scheduled: false, candidates: true };
  }

  // Handles job execution and cleanup
  async runJob (job) {
    try {
      // Keep a minimal in-memory record.
      const runtimeJob = {
        _id: job._id,
        path: job.path,
        computeScore: job.computeScore,
        sortFields: job.sortFields,
        action: 'queued',
        refreshed: Date.now()
      };
      this.runningJobs.push(runtimeJob);

      // Load the full Mongoose document only for the job being executed.
      const fullDoc = await File.findById(job._id);
      if (!fullDoc) throw new Error(`File record not found: ${job._id}`);
      await integrityCheck(fullDoc); // Await external ffmpeg logic
    } catch (err) {
      console.error(`Integrity check failed for ${job.inputPath}: ${err.message}`);
    } finally {
      // Always clean up the memory queue
      this.runningJobs = this.runningJobs.filter(
        (j) => j._id.toString() !== job._id.toString()
      );
    }
  }
}
