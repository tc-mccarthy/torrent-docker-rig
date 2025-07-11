import cron from 'node-cron';
import dayjs from 'dayjs';
import mongo_connect from './lib/mongo_connection';
import update_active from './lib/update_active';
import update_queue from './lib/update_queue';
import transcode_loop from './lib/transcode_loop';
import fs_monitor from './lib/fs_monitor';
import redisClient from './lib/redis';
import logger from './lib/logger';
import { get_utilization, get_disk_space } from './lib/metrics';
import pre_sanitize from './lib/pre_sanitize';
import { create_scratch_disks } from './lib/fs';
import config from './lib/config';
import generate_filelist from './lib/generate_filelist';
import integrity_loop from './lib/integrity_check_loop';

const {
  concurrent_transcodes,
  concurrent_integrity_checks,
  application_version
} = config;

async function run () {
  try {
    logger.info('Starting transcode service...', {
      label: 'STARTUP',
      application_version
    });
    logger.info('Connecting to MongoDB');
    // connect to mongo
    await mongo_connect();

    logger.info('Connecting to Redis');
    // connect to redis
    await redisClient.connect();

    // update the active list
    update_active();

    // create scratch disks
    logger.info('Creating scratch space');
    await create_scratch_disks();

    // getting system utilization values
    logger.info('Getting system utilization values');
    get_utilization();

    // getting disk space
    logger.info('Getting disk space');
    get_disk_space();

    // start the file monitor
    fs_monitor();

    // update the transcode queue
    update_queue();

    // start the transcode loops
    logger.info(`Starting ${concurrent_transcodes} transcode loops...`);

    Array.from({ length: concurrent_transcodes }).forEach((val, idx) => {
      transcode_loop(idx);
    });

    const currentHourLocalTime = dayjs().tz(process.env.TZ).hour();
    logger.info(
      `Current local time is ${currentHourLocalTime}`
    );
    if (currentHourLocalTime >= 0 && currentHourLocalTime < 9) {
      logger.info(
        'Starting integrity check loop immediately since it is before 9 AM'
      );
      integrity_loop();
    }

    // start the integrity check loops every day at midnight
    cron.schedule('0 0 * * *', () => {
      logger.info(
        `Starting ${concurrent_integrity_checks} integrity check loops...`
      );
      Array.from({ length: concurrent_integrity_checks }).forEach(
        (val, idx) => {
          integrity_loop(idx);
        }
      );
    });

    // generate the filelist every 10 minutes
    cron.schedule('*/5 * * * *', async () => {
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
