import { setTimeout as delay } from 'timers/promises';
import si from 'systeminformation'; // For system resource monitoring
import transcode from './transcode';
import logger from './logger';
import generate_filelist from './generate_filelist';
import update_status from './update_status';
import update_active from './update_active';

export default class TranscodeQueue {
  constructor ({ maxScore = 4, pollDelay = 2000 }) {
    // start the transcode loops
    logger.info(`Initiating transcode queue for a max compute of ${maxScore}...`);
    this.maxScore = maxScore; // Max compute units allowed simultaneously
    this.computePenalty = 0; // Current compute penalty based on system resource utilization
    this.memoryPollIntervalMs = 5000; // Interval for memory pressure checks (ms)
    this.pollDelay = pollDelay; // Delay between scheduling attempts (ms)
    this.runningJobs = []; // In-memory list of currently active jobs
    this._isRunning = false; // Flag for controlling the loop
  }

  // Starts the recursive scheduling loop
  async start () {
    if (this._isRunning) return;
    this._isRunning = true;
    logger.info('Transcode queue started.');
    update_active();
    this.startMemoryPressureMonitor(); // Start monitoring system resources
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

  async startMemoryPressureMonitor () {
    try {
      const [mem] = await Promise.all([
        si.mem()
      ]);

      const availableRamMB = mem.available / 1024 / 1024;
      const usedSwapMB = mem.swapused / 1024 / 1024;
      // const cpuLoadPct = cpu.currentLoad; // Average across all cores

      let penalty = 0;

      // 🔴 RAM pressure
      if (availableRamMB < 8192) penalty += 0.5;
      if (availableRamMB < 4096) penalty += 0.5;

      // 🟠 Swap pressure
      // if (usedSwapMB > 1024) penalty += 0.25;
      // if (usedSwapMB > 2048) penalty += 0.25;

      // // 🔵 CPU pressure
      // if (cpuLoadPct > 85) penalty += 0.25;
      // if (cpuLoadPct > 95) penalty += 0.25;

      this.computePenalty = penalty;

      logger.info(penalty, {
        label: 'ResourceMonitor compute penalty',
        ram: `${Math.round(availableRamMB)}MB`,
        swap: `${Math.round(usedSwapMB)}MB`
        // cpu: `${Math.round(cpuLoadPct)}%`
      });
    } catch (err) {
      console.error('[ResourceMonitor] Error:', err);
    } finally {
      await delay(this.memoryPollIntervalMs);
      this.startMemoryPressureMonitor(); // Restart the monitor
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
      this.runningJobs.push(job);
      await transcode(job); // Await external ffmpeg logic
    } catch (err) {
      console.error(`Transcoding failed for ${job.inputPath}: ${err.message}`);
    } finally {
      // Always clean up the memory queue
      this.runningJobs = this.runningJobs.filter(
        (j) => j._id.toString() !== job._id.toString()
      );

      update_status(); // Update status after job completion or failure
      generate_filelist({ limit: 1000, writeToFile: true }); // Regenerate file list after job completion
    }
  }
}
