/**
 * TranscodeQueue
 * A smart queue for transcoding video jobs using a unified compute score
 * across independent CPU and memory compute pools. Supports system resource
 * penalties, job prioritization, and starvation protection.
 */

import { setTimeout as delay } from 'timers/promises';
import fs from 'fs/promises';
import si from 'systeminformation';
import transcode from './transcode';
import logger from './logger';
import generate_filelist from './generate_filelist';
import { getCpuLoadPercentage } from './getCpuLoadPercentage';

export default class TranscodeQueue {
  /**
   * @param {Object} options
   * @param {number} options.maxMemoryComputeScore - Maximum allowed memory compute score
   * @param {number} options.maxCpuComputeScore - Maximum allowed CPU compute score
   * @param {number} options.pollDelay - Time between scheduling loops in ms
   */
  constructor ({ maxMemoryComputeScore = 4, maxCpuComputeScore = 2, pollDelay = 2000 }) {
    logger.debug(`Initiating transcode queue with max compute (Memory: ${maxMemoryComputeScore}, CPU: ${maxCpuComputeScore})`);
    this.maxMemoryComputeScore = maxMemoryComputeScore;
    this.maxCpuComputeScore = maxCpuComputeScore;
    this.memoryPenalty = 0;
    this.cpuPenalty = 0;
    this.pollDelay = pollDelay;
    this.runningJobs = [];
    this._isRunning = false;

    // Shared sampling window for CPU and memory pressure (10 min @ 5s/sample)
    this.resourcePollIntervalMs = 5000;
    this.maxResourceSamples = 10 * 60 * 1000 / this.resourcePollIntervalMs;

    // Rolling sample buffers
    this.memoryUsageSamples = [];
    this.cpuUsageSamples = [];

    // Periodic flush of job state to disk
    this.flushIntervalMs = 10000;
    this.flushPath = '/usr/app/output/active.json';

    // Starvation detection
    this.starvationCounter = 0;
    this.lastBlockedJobId = null;
  }

  /** Starts the queue loop and resource monitors */
  async start () {
    if (this._isRunning) return;
    this._isRunning = true;
    logger.debug('Transcode queue started.');
    this.startResourceMonitors();
    this.startFlushLoop();
    await this.loop();
  }

  /** Stops the scheduling loop */
  stop () {
    this._isRunning = false;
    console.log('Transcode queue stopped.');
  }

  /** @returns {number} Total memory compute in use */
  getUsedMemoryCompute () {
    return this.runningJobs.reduce((sum, job) => sum + (job.computeScore || 1), 0);
  }

  /** @returns {number} Available memory compute after penalties */
  getAvailableMemoryCompute () {
    return this.maxMemoryComputeScore - this.memoryPenalty - this.getUsedMemoryCompute();
  }

  /** @returns {number} Total CPU compute in use */
  getUsedCpuCompute () {
    return this.runningJobs.reduce((sum, job) => sum + (job.computeScore || 1), 0);
  }

  /** @returns {number} Available CPU compute after penalties */
  getAvailableCpuCompute () {
    return this.maxCpuComputeScore - this.cpuPenalty - this.getUsedCpuCompute();
  }

  /**
   * @returns {number} Minimum available compute across memory and CPU.
   * Used to determine whether a new job can be scheduled.
   */
  getAvailableCompute () {
    return Math.min(this.getAvailableMemoryCompute(), this.getAvailableCpuCompute());
  }

  /** Main loop: repeatedly attempts to schedule jobs */
  async loop () {
    while (this._isRunning) {
      await this.scheduleJobs();
      await delay(this.pollDelay);
    }
  }

  /** Starts both memory and CPU resource monitoring loops */
  startResourceMonitors () {
    this.startMemoryPressureMonitor();
    this.startCpuPressureMonitor();
  }

  /**
   * Monitors memory usage and applies penalty when average usage exceeds thresholds.
   * Penalizes compute when memory usage exceeds 85% and again at 90%.
   */
  async startMemoryPressureMonitor () {
    while (true) {
      try {
        const mem = await si.mem();
        this.memoryUsageSamples.push(mem.available);
        if (this.memoryUsageSamples.length > this.maxResourceSamples) {
          this.memoryUsageSamples.shift();
        }

        const avgAvailable = this.memoryUsageSamples.reduce((a, b) => a + b, 0) / this.memoryUsageSamples.length;
        const memUsedPercent = 100 - (avgAvailable / mem.total * 100);

        let penalty = 0;
        if (memUsedPercent > 85) penalty += this.maxMemoryComputeScore / 2;
        if (memUsedPercent > 90) penalty += this.maxMemoryComputeScore / 2;

        this.memoryPenalty = penalty;
        logger.debug(`[ResourceMonitor] Memory Penalty: ${penalty.toFixed(2)} | Avg Mem Used: ${memUsedPercent.toFixed(1)}%`);
      } catch (err) {
        console.error('[ResourceMonitor] Memory Error:', err);
      }
      await delay(this.resourcePollIntervalMs);
    }
  }

  /**
   * Monitors CPU load and applies penalty based on a rolling 10-minute average.
   * Uses load-to-core ratio to adapt thresholds across systems with different core counts.
   */
  async startCpuPressureMonitor () {
    while (true) {
      try {
        const { loadPercent, loadRatio } = await getCpuLoadPercentage();

        logger.debug({ loadPercent, loadRatio }, { label: `[ResourceMonitor] CPU Load Ratio` });

        this.cpuUsageSamples.push(loadRatio);
        if (this.cpuUsageSamples.length > this.maxResourceSamples) {
          this.cpuUsageSamples.shift();
        }

        const avgCpuRatio = this.cpuUsageSamples.reduce((a, b) => a + b, 0) / this.cpuUsageSamples.length;

        let penalty = 0;
        if (avgCpuRatio > 4.0) penalty += this.maxCpuComputeScore / 2;
        if (avgCpuRatio > 6.0) penalty += this.maxCpuComputeScore / 2;

        this.cpuPenalty = penalty;
        logger.debug(`[ResourceMonitor] CPU Penalty: ${penalty} | Avg Load Ratio (10 min): ${avgCpuRatio.toFixed(2)}x per core`);
      } catch (err) {
        console.error('[ResourceMonitor] CPU Error:', err);
      }
      await delay(this.resourcePollIntervalMs);
    }
  }

  /**
   * Attempts to find and start a job that fits within both memory and CPU compute limits.
   * Honors priority order and introduces starvation detection for blocked jobs.
   */
  async scheduleJobs () {
    // Block scheduling if any job is in 'staging' or 'finalizing' action
    const blockingJob = this.runningJobs.find((j) => j.action === 'staging' || j.action === 'finalizing');
    if (blockingJob) {
      logger.debug(`[QUEUE] Blocking new jobs: job ${blockingJob._id} is in '${blockingJob.action}' stage.`);
      return;
    }

    const availableMemory = this.getAvailableMemoryCompute();
    const availableCpu = this.getAvailableCpuCompute();
    const availableCompute = this.getAvailableCompute();

    logger.debug(`Available compute (Memory: ${availableMemory}, CPU: ${availableCpu}, Unified: ${availableCompute})`);
    if (availableCompute <= 0) return;

    const jobs = await generate_filelist({ limit: 250 });

    // Find the first job in the queue that cannot run due to lack of compute
    const blockedEntry = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j._id.toString() === job._id.toString());
      return !alreadyRunning && job.computeScore > availableCompute;
    });

    if (blockedEntry) {
      this.starvationCounter = this.lastBlockedJobId?.toString() === blockedEntry._id.toString()
        ? this.starvationCounter += 1
        : 1;
      this.lastBlockedJobId = blockedEntry._id;
      logger.debug(`[QUEUE] Blocked job ${blockedEntry.path} | Compute ${blockedEntry.computeScore} | Starvation ${this.starvationCounter}`);
    } else {
      this.starvationCounter = 0;
      this.lastBlockedJobId = null;
    }

    // Select the next job that fits within the compute and respects priority/starvation rules
    const nextJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j._id.toString() === job._id.toString());
      if (alreadyRunning) return false;

      if (job.computeScore > availableCompute) return false;

      if (blockedEntry && job.sortFields.priority > blockedEntry.sortFields.priority) return false;

      if (blockedEntry && job.sortFields.priority === blockedEntry.sortFields.priority && this.starvationCounter >= 5) return false;

      return true;
    });

    if (nextJob) this.runJob(nextJob);
  }

  /**
   * Starts the transcode process for a given job and removes it from memory when done.
   * @param {Object} job - Job document with ._id, .computeScore, and .path
   */
  async runJob (job) {
    try {
      this.runningJobs.push({ ...job.toObject(), file: job.path });
      await transcode(job);
    } catch (err) {
      console.error(`Transcoding failed for ${job.path}: ${err.message}`);
    } finally {
      this.runningJobs = this.runningJobs.filter((j) => j._id.toString() !== job._id.toString());
      generate_filelist({ limit: 1000, writeToFile: true });
    }
  }

  /** Starts a loop that periodically writes the job queue state to disk */
  async startFlushLoop () {
    while (this._isRunning) {
      await this.flushActiveJobs();
      await delay(this.flushIntervalMs);
    }
  }

  /** Flushes the current job state and available compute scores to disk */
  async flushActiveJobs () {
    try {
      const flushObj = {
        active: this.runningJobs,
        availableMemoryCompute: this.getAvailableMemoryCompute(),
        availableCpuCompute: this.getAvailableCpuCompute(),
        availableCompute: this.getAvailableCompute(),
        memoryPenalty: this.memoryPenalty,
        cpuPenalty: this.cpuPenalty,
        refreshed: Date.now()
      };
      await fs.writeFile(this.flushPath, JSON.stringify(flushObj, null, 2));
    } catch (err) {
      logger.error('Failed to flush active jobs:', err);
    }
  }
}
