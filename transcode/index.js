import cron from 'node-cron';
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
import db_cleanup from './lib/db_cleanup';
import config from './lib/config';
import generate_filelist from './lib/generate_filelist';

const {concurrent_transcodes} = config;

async function run () {
  try {
    // connect to mongo
    await mongo_connect();

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

    // cleaning up
    logger.info('Cleaning up the FS before running the queue');
    pre_sanitize();

    // start the file monitor
    fs_monitor();

    // update the transcode queue
    update_queue();

    // start the transcode loops
    logger.info(`Starting ${concurrent_transcodes} transcode loops...`);

    Array.from({ length: concurrent_transcodes }).forEach((val, idx) => {
      transcode_loop(idx);
    });

    // generate the filelist every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
      generate_filelist();
    });

    // schedule the cleanup tasks
    cron.schedule('0 */3 * * *', () => {
      db_cleanup();
    });

    // schedule the queue update
    cron.schedule('0 0 * * *', () => {
      update_queue();
    });
  } catch (e) {
    logger.error(e, { label: 'RUN ERROR' });
  }
}

run();
