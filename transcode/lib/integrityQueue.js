import { setTimeout as delay } from 'timers/promises';
import integrityCheck from './integrityCheck';
import logger from './logger';
import generate_integrity_filelist from './generate_integrity_filelist';

export default class IntegrityQueue {
  constructor ({ maxScore = 4, pollDelay = 2000 }) {
    // start the integrity check loops
    logger.debug(`Initiating integrity check queue for a max compute of ${maxScore}...`);
    this.maxScore = maxScore; // Max compute units allowed simultaneously
    this.pollDelay = pollDelay; // Delay between scheduling attempts (ms)
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
      await this.scheduleJobs();
      await delay(this.pollDelay); // Wait before checking again
    }
  }

  // Attempts to find and run a job that fits within available compute
  async scheduleJobs () {
    const availableCompute = this.getAvailableCompute();
    logger.debug(`Available integrity check compute: ${availableCompute}.`);

    if (availableCompute <= 0) return;

    const jobs = await generate_integrity_filelist({ limit: 50 });

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
    }
  }

  // Handles job execution and cleanup
  async runJob (job) {
    try {
      this.runningJobs.push(job);
      await integrityCheck(job); // Await external ffmpeg logic
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
