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

  /** Main scheduling loop */
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
        this.memoryUsageSamples = [...this.memoryUsageSamples.slice(-this.maxResourceSamples + 1), mem.available];

        const avgAvailable = this.memoryUsageSamples.reduce((a, b) => a + b, 0) / this.memoryUsageSamples.length;
        const memUsedPercent = 100 - (avgAvailable / mem.total * 100);

        let penalty = 0;
        if (memUsedPercent > 85) penalty += this.maxMemoryComputeScore / 2;
        if (memUsedPercent > 90) penalty += this.maxMemoryComputeScore / 2;

        this.memoryPenalty = penalty;
        console.log(`[ResourceMonitor] Memory Penalty: ${penalty.toFixed(2)} | Avg Mem Used: ${memUsedPercent.toFixed(1)}%`);
      } catch (err) {
        console.error('[ResourceMonitor] Memory Error:', err);
      }
      await delay(this.resourcePollIntervalMs);
    }
  }

  /**
   * Monitors CPU load and applies penalty based on a rolling 10-minute average.
   * Penalizes by half of maxCpuComputeScore when CPU load > 80% and again > 110%.
   */
  async startCpuPressureMonitor () {
    while (true) {
      try {
        const load = await si.currentLoad();
        const avgLoad = load.avgLoad * 100 / load.cpus.length;
        this.cpuUsageSamples = [...this.cpuUsageSamples.slice(-this.maxResourceSamples + 1), avgLoad];

        const avgCpuLoad = this.cpuUsageSamples.reduce((a, b) => a + b, 0) / this.cpuUsageSamples.length;

        let penalty = 0;
        if (avgCpuLoad > 80) penalty += this.maxCpuComputeScore / 2;
        if (avgCpuLoad > 110) penalty += this.maxCpuComputeScore / 2;

        this.cpuPenalty = penalty;
        console.log(`[ResourceMonitor] CPU Penalty: ${penalty} | Avg CPU Load (10 min): ${avgCpuLoad.toFixed(1)}%`);
      } catch (err) {
        console.error('[ResourceMonitor] CPU Error:', err);
      }
      await delay(this.resourcePollIntervalMs);
    }
  }

  /**
   * Attempts to find and start a job that fits within both memory and CPU compute limits.
   * Applies starvation logic and honors job priority.
   */
  async scheduleJobs () {
    const availableMemory = this.getAvailableMemoryCompute();
    const availableCpu = this.getAvailableCpuCompute();
    const availableCompute = Math.min(availableMemory, availableCpu);

    logger.debug(`Available compute (Memory: ${availableMemory}, CPU: ${availableCpu})`);
    if (availableCompute <= 0) return;

    const jobs = await generate_filelist({ limit: 50 });
    let blockedJob = null;

    // Identify the first job that cannot run due to insufficient compute.
    jobs.some((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j._id.toString() === job._id.toString());
      if (alreadyRunning) return false;
      if (job.computeScore > availableCompute) {
        blockedJob = job;
        this.starvationCounter = this.lastBlockedJobId?.toString() === job._id.toString() ? this.starvationCounter += 1 : 1;
        this.lastBlockedJobId = job._id;
        logger.debug(`[QUEUE] Blocked job ${job.path} | Compute ${job.computeScore} | Starvation ${this.starvationCounter}`);
        return true;
      }
      return false;
    });

    if (!blockedJob) {
      this.starvationCounter = 0;
      this.lastBlockedJobId = null;
    }

    /**
     * Finds a job eligible to run based on compute score and priority logic.
     * - Must not already be running.
     * - Must fit within available compute.
     * - Must not bypass higher-priority or starved jobs.
     */
    const nextJob = jobs.find((job) => {
      const alreadyRunning = this.runningJobs.some((j) => j._id.toString() === job._id.toString());
      if (alreadyRunning) return false;

      if (job.computeScore > availableCompute) return false;

      if (blockedJob && job.sortFields.priority > blockedJob.sortFields.priority) return false;

      if (blockedJob && job.sortFields.priority === blockedJob.sortFields.priority && this.starvationCounter >= 5) return false;

      return true;
    });

    if (nextJob) this.runJob(nextJob);
  }

  /**
   * Starts transcoding job and removes it from memory on completion.
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

  /** Periodically flushes current queue state to disk */
  async startFlushLoop () {
    while (this._isRunning) {
      await this.flushActiveJobs();
      await delay(this.flushIntervalMs);
    }
  }

  /** Writes current job state and available compute to disk */
  async flushActiveJobs () {
    try {
      const flushObj = {
        active: this.runningJobs,
        availableMemoryCompute: this.getAvailableMemoryCompute(),
        availableCpuCompute: this.getAvailableCpuCompute(),
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
