import { setTimeout as delay } from 'timers/promises';
import transcode from './transcode';
import logger from './logger';
import generate_filelist from './generate_filelist';

export default class TranscodeQueue {
  constructor ({ maxScore = 4, pollDelay = 2000 }) {
    // start the transcode loops
    logger.info(`Initiating transcode queue for a max compute of ${maxScore}...`);
    this.maxScore = maxScore; // Max compute units allowed simultaneously
    this.pollDelay = pollDelay; // Delay between scheduling attempts (ms)
    this.runningJobs = []; // In-memory list of currently active jobs
    this._isRunning = false; // Flag for controlling the loop
  }

  // Starts the recursive scheduling loop
  async start () {
    if (this._isRunning) return;
    this._isRunning = true;
    logger.info('Transcode queue started.');
    await this.loop();
  }

  // Stops the queue
  stop () {
    this._isRunning = false;
    console.log('Transcode queue stopped.');
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
    if (availableCompute <= 0) return;

    const jobs = await generate_filelist({ limit: 50 });

    const nextJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some(
        (j) => j._id.toString() === job._id.toString()
      );
      return !alreadyRunning && job.computeScore <= availableCompute;
    });

    if (nextJob) {
      this.runJob(nextJob);
    }
  }

  // Handles job execution and cleanup
  async runJob (job) {
    try {
      this.runningJobs.push(job);
      await transcode(job); // Await external ffmpeg logic
    } catch (err) {
      console.error(`Transcoding failed for ${job.inputPath}: ${err.message}`);
    } finally {
      // Always clean up the memory queue
      this.runningJobs = this.runningJobs.filter(
        (j) => j._id.toString() !== job._id.toString()
      );
    }
  }
}
