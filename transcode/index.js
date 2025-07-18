import cron from 'node-cron';
import mongo_connect from './lib/mongo_connection';
import update_queue from './lib/update_queue';
import fs_monitor from './lib/fs_monitor';
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

const {
  concurrent_transcodes,
  concurrent_integrity_checks,
  application_version
} = config;

async function run () {
  try {
    logger.debug('Starting transcode service...', {
      label: 'STARTUP',
      application_version
    });
    logger.debug('Connecting to MongoDB');
    // connect to mongo
    await mongo_connect();

    logger.debug('Connecting to Redis');
    // connect to redis
    await redisClient.connect();

    // create scratch disks
    logger.debug('Creating scratch space');
    await create_scratch_disks();

    // getting system utilization values
    logger.debug('Getting system utilization values');
    get_utilization();

    // getting disk space
    logger.debug('Getting disk space');
    get_disk_space();

    // start the file monitor
    fs_monitor();

    // update the transcode queue
    update_status();
    update_queue();
    generate_filelist({ limit: 1000, writeToFile: true });

    const transcodeQueue = new TranscodeQueue({ maxScore: concurrent_transcodes, pollDelay: 30000 });
    transcodeQueue.start();

    global.transcodeQueue = transcodeQueue; // Make the queue globally accessible

    const integrityQueue = new IntegrityQueue({ maxScore: concurrent_integrity_checks });

    integrityQueue.start();

    // generate the filelist every 5 minutes
    cron.schedule('*/5 * * * *', () => {
      generate_filelist({ limit: 1000, writeToFile: true });
    });

    // schedule the cleanup tasks
    cron.schedule('0 */3 * * *', () => {
      pre_sanitize();
    });

    // schedule the queue update
    cron.schedule('0 0 * * *', () => {
      update_queue();
    });
  } catch (e) {
    logger.error(e, { label: 'RUN ERROR', message: e.message });
  }
}

logger.info('Starting transcode service...', {
  label: 'STARTUP',
  application_version
});
run();
