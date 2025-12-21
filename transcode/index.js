/**
 * Entrypoint for the transcode service.
 *
 * This script initializes all core services, schedules background jobs, and starts the main transcode and integrity queues.
 *
 * - Connects to MongoDB and Redis
 * - Ensures scratch disks exist
 * - Starts system resource monitoring
 * - Starts file system monitor
 * - Schedules periodic filelist generation, queue updates, and cleanup
 * - Starts the transcode and integrity queues
 */

import cron from 'node-cron';
import mongo_connect from './lib/mongo_connection';
import update_queue from './lib/update_queue';
// import fs_monitor, { processFSEventQueue } from './lib/fs_monitor';
import redisClient from './lib/redis';
import logger from './lib/logger';
import { get_utilization, get_disk_space } from './lib/metrics';
import pre_sanitize from './lib/pre_sanitize';
import { create_scratch_disks } from './lib/fs';
import config from './lib/config';
import generate_filelist from './lib/generate_filelist';
import IntegrityQueue from './lib/integrityQueue';
import TranscodeQueue from './lib/transcodeQueue';
import update_status from './lib/update_status';
import refresh_indexer_data from './lib/refresh_indexer_data';
import { downgradeAudio } from './lib/adjust_custom_format_scores';

const {
  max_memory_score, max_cpu_score,
  concurrent_integrity_checks,
  application_version
} = config;

async function pre_start () {
  // Update the transcode queue and status, and generate the initial filelist
  logger.info('Updating system status metrics');
  await update_status({ startup: true });

  logger.info('Refreshing transcode queue');
  await update_queue();

  logger.info('Refreshing indexer data');
  await refresh_indexer_data();

  logger.info('Adjusting custom format scores for FDK AAC surround files');
  await downgradeAudio();

  logger.info('Generating initial filelist');
  await generate_filelist({ limit: 1000, writeToFile: true });
}

/**
 * Main startup routine for the transcode service.
 *
 * Connects to all required services, starts background jobs, and launches the main queues.
 * All errors are logged and do not crash the process.
 *
 * @returns {Promise<void>}
 */
async function run () {
  try {
    logger.debug('Starting transcode service...', {
      label: 'STARTUP',
      application_version
    });
    logger.debug('Connecting to MongoDB');
    // Connect to MongoDB
    await mongo_connect();

    logger.debug('Connecting to Redis');
    // Connect to Redis
    await redisClient.connect();

    // Create scratch disks for all sources
    logger.debug('Creating scratch space');
    await create_scratch_disks();

    // Start system utilization monitoring (CPU/memory)
    logger.debug('Getting system utilization values');
    get_utilization();

    // Start disk space monitoring
    logger.debug('Getting disk space');
    get_disk_space();

    // Start the file system monitor (watches for new/changed files)
    // logger.info('Starting file system monitor');
    // processFSEventQueue();
    // fs_monitor();

    pre_start();

    // Start the main transcode queue (handles video jobs)
    const transcodeQueue = new TranscodeQueue({ maxMemoryComputeScore: max_memory_score, maxCpuComputeScore: max_cpu_score, pollDelay: 10000 });
    transcodeQueue.start();
    global.transcodeQueue = transcodeQueue; // Make the queue globally accessible

    // Start the integrity queue (handles file integrity checks)
    const integrityQueue = new IntegrityQueue({ maxScore: concurrent_integrity_checks });
    integrityQueue.start();
    global.integrityQueue = integrityQueue; // Make the queue globally accessible

    // Schedule filelist regeneration every 5 minutes
    cron.schedule('*/5 * * * *', () => {
      generate_filelist({ limit: 1000, writeToFile: true });
    });

    // Schedule pre-sanitize cleanup every 3 hours
    cron.schedule('0 */3 * * *', () => {
      pre_sanitize();
    });

    // Schedule queue update every day at midnight
    cron.schedule('0 0 * * *', () => {
      update_queue().then(() => {
        refresh_indexer_data();
      });
    });

    // update indexer data every hour from 3am to 11pm
    // to avoid peak usage times during the update_queue logic
    cron.schedule('0 3-23 * * *', () => {
      refresh_indexer_data();
    });
  } catch (e) {
    logger.error(e, { label: 'RUN ERROR', message: e.message });
  }
}

// Log startup and invoke the main routine
logger.info('Starting transcode service...', {
  label: 'STARTUP',
  application_version
});
run();
