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
    logger.info(`Available transcode compute: ${availableCompute}.`);

    if (availableCompute <= 0) return;

    logger.info('Checking for new jobs to run...');
    const jobs = await generate_filelist({ limit: 50 });

    // Are there any jobs being blocked due to lack of compute?
    const blockedHighPriorityJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j._id.toString() === job._id.toString());
      return !alreadyRunning && job.computeScore > availableCompute;
    });

    if (blockedHighPriorityJob) {
      logger.info(blockedHighPriorityJob.path, { label: 'High Priority Job Blocked due to lack of compute' });
    }

    // Now let's find the next job that will fit within available compute
    const nextJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j._id.toString() === job._id.toString()); // skip any already running jobs
      if (alreadyRunning || job.computeScore > availableCompute) return false; // discount any jobs that are already running or exceed available compute

      // If a higher-priority job is blocked, don't schedule lower-priority jobs
      if (blockedHighPriorityJob && job.sortFields.priority > blockedHighPriorityJob.sortFields.priority) {
        logger.info(`Skipping file ${job.path} because ${blockedHighPriorityJob.path} has a higher priority and is awaiting available compute.`);
        return false; // if a higher-priority job is blocked, don't schedule lower-priority jobs, let the queue open up to process the higher-priority job
      }

      if (blockedHighPriorityJob) {
        logger.info(`Scheduling file ${job.path} because ${blockedHighPriorityJob.path} does not have a higher priority than this job.`, { blockedPriority: blockedHighPriorityJob.sortFields.priority, jobPriority: job.sortFields.priority, note: 'Lower numbers indicate higher importance' });
      }

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
