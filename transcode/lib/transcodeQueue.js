import { setTimeout as delay } from 'timers/promises';
import fs from 'fs/promises';
import si from 'systeminformation'; // For system resource monitoring
import transcode from './transcode';
import logger from './logger';
import generate_filelist from './generate_filelist';
// import update_active from './update_active';

export default class TranscodeQueue {
  constructor ({ maxScore = 4, pollDelay = 2000 }) {
    // start the transcode loops
    logger.info(`Initiating transcode queue for a max compute of ${maxScore}...`);
    this.maxScore = maxScore; // Max compute units allowed simultaneously
    this.computePenalty = 0; // Current compute penalty based on system resource utilization
    this.pollDelay = pollDelay; // Delay between scheduling attempts (ms)
    this.runningJobs = []; // In-memory list of currently active jobs
    this._isRunning = false; // Flag for controlling the loop

    // Stores the last 10 minutes of memory usage samples
    this.memoryPollIntervalMs = 5000; // Interval for memory pressure checks (ms)
    this.memoryUsageSamples = [];
    this.maxMemorySamples = 10 * 60 * 1000 / this.memoryPollIntervalMs; // 10 min @ 5s/sample

    this.flushIntervalMs = 10000; // 10 seconds
    this.flushPath = '/usr/app/output/active.json';
  }

  // Starts the recursive scheduling loop
  async start () {
    if (this._isRunning) return;
    this._isRunning = true;
    logger.info('Transcode queue started.');
    // update_active();
    this.startMemoryPressureMonitor(); // Start monitoring system resources
    this.startFlushLoop(); // Start periodic flush
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
    return this.maxScore - this.computePenalty - this.getUsedCompute();
  }

  // Main loop: tries to schedule jobs and waits before the next run
  async loop () {
    while (this._isRunning) {
      await this.scheduleJobs();
      await delay(this.pollDelay); // Wait before checking again
    }
  }

  /**
   * Monitors system memory usage.
   * Applies half of maxScore as a penalty when 10-minute avg memory > 85%.
   * Applies full maxScore penalty when 10-minute avg memory > 90%.
   */
  /**
   * Starts monitoring memory usage over a rolling 10-minute window.
   * Applies penalties based on average memory usage / total memory.
   */
  async startMemoryPressureMonitor () {
    while (true) {
      try {
        const mem = await si.mem();

        this.memoryUsageSamples.push(mem.available);

        if (this.memoryUsageSamples.length > this.maxMemorySamples) {
          this.memoryUsageSamples.shift(); // Maintain a rolling buffer of samples
        }

        const memoryAvailableAverage = this.memoryUsageSamples.reduce((sum, val) => sum + val, 0) / this.memoryUsageSamples.length;
        const memoryUsagePercent = 100 - (memoryAvailableAverage / mem.total * 100);

        // Apply penalties
        let penalty = 0;
        if (memoryUsagePercent > 85) penalty += this.maxScore / 2;
        if (memoryUsagePercent > 90) penalty += this.maxScore / 2;

        this.computePenalty = penalty;

        console.log(
          `[ResourceMonitor] Penalty: ${penalty.toFixed(2)} | 10-min Avg Mem: ${memoryUsagePercent.toFixed(1)}%`
        );
      } catch (err) {
        console.error('[ResourceMonitor] Error:', err);
      }

      await delay(this.memoryPollIntervalMs);
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
      logger.debug(blockedHighPriorityJob.path, { label: 'High Priority Job Blocked due to lack of compute' });
    }

    // Now let's find the next job that will fit within available compute
    const nextJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j._id.toString() === job._id.toString()); // skip any already running jobs
      if (alreadyRunning || job.computeScore > availableCompute) return false; // discount any jobs that are already running or exceed available compute

      // If a higher-priority job is blocked, don't schedule lower-priority jobs
      if (blockedHighPriorityJob && job.sortFields.priority > blockedHighPriorityJob.sortFields.priority) {
        logger.debug(`Skipping file ${job.path} because ${blockedHighPriorityJob.path} has a higher priority and is awaiting available compute.`);
        return false; // if a higher-priority job is blocked, don't schedule lower-priority jobs, let the queue open up to process the higher-priority job
      }

      if (blockedHighPriorityJob) {
        logger.debug(`Scheduling file ${job.path} because ${blockedHighPriorityJob.path} does not have a higher priority than this job.`, { blockedPriority: blockedHighPriorityJob.sortFields.priority, jobPriority: job.sortFields.priority, note: 'Lower numbers indicate higher importance' });
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
      this.runningJobs.push({ ...job.toObject(), file: job.path });
      await transcode(job); // Await external ffmpeg logic
      logger.info(`Transcode job complete for ${job.path}`);
    } catch (err) {
      console.error(`Transcoding failed for ${job.path}: ${err.message}`);
    } finally {
      // Always clean up the memory queue
      this.runningJobs = this.runningJobs.filter(
        (j) => j._id.toString() !== job._id.toString()
      );

      generate_filelist({ limit: 1000, writeToFile: true }); // Regenerate file list after job completion
    }
  }

  async startFlushLoop () {
    while (this._isRunning) {
      await this.flushActiveJobs();
      await delay(this.flushIntervalMs);
    }
  }

  async flushActiveJobs () {
    try {
      const flushObj = {
        active: this.runningJobs,
        availableCompute: this.getAvailableCompute(),
        refreshed: Date.now()
      };
      await fs.writeFile(this.flushPath, JSON.stringify(flushObj, null, 2));
    } catch (err) {
      logger.error('Failed to flush active jobs:', err);
    }
  }
}
