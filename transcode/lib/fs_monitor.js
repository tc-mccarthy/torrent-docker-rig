import chokidar from 'chokidar';
import async from 'async';
import config from './config';
import redisClient from './redis';
import logger from './logger';
import probe_and_upsert from './probe_and_upsert';

const { file_ext } = config;

const { get_paths } = config;

const PATHS = get_paths(config);

const STREAM_KEY = 'transcode_file_events';

async function sendToStream (msg) {
  try {
    logger.info(msg, { label: 'REDIS STREAM SEND' });
    await redisClient.xAdd(STREAM_KEY, '*', { ...msg });
  } catch (e) {
    logger.error(e, { label: 'REDIS STREAM SEND ERROR' });
  }
}

export async function processFSEventQueue () {
  try {
    logger.info('Starting Redis stream receiver...', { label: 'REDIS STREAM RECEIVE' });
    let lastId = '0-0';
    while (true) {
      const response = await redisClient.xRead(
        [{ key: STREAM_KEY, id: lastId }],
        { BLOCK: 0, COUNT: 1 }
      );
      if (response && response.length > 0) {
        const [stream] = response;
        const messages = stream.messages;
        await async.eachSeries(messages, async (message) => {
          try {
            logger.info(`Processing file system event for file: ${message.message.path}`, { label: 'REDIS STREAM READ', message_content: message.message });
            await probe_and_upsert(message.message.path);
          } catch (e) {
            logger.error(e, { label: 'REDIS STREAM READ ERROR' });
          }
        });
        if (messages.length > 0) {
          lastId = messages[messages.length - 1].id;
        }
      }
    }
  } catch (e) {
    logger.error(e, { label: 'REDIS STREAM RECEIVE ERROR' });
  }
}

export default function fs_watch () {
  logger.info('Starting file system monitor...', { label: 'FS MONITOR' });
  const watcher = chokidar.watch(PATHS, {
    ignored: (file, stats) => {
      // if .deletedByTMM is in the path, ignore
      if (file.includes('.deletedByTMM')) {
        return true;
      }

      // if the file doesn't have a file extension at all, or it has an approved file_ext do not ignore
      if (!/\.[A-Za-z0-9]+$/i.test(file)) {
        return false;
      }

      return !file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(file));
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: true
  });

  watcher
    .on('ready', () => {
      logger.info('>> WATCHER IS READY AND WATCHING >>', watcher.getWatched());
    })
    .on('error', (error) => logger.error(`Watcher error: ${error}`))
    .on('add', (path) => {
      if (file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(path))) {
        logger.debug('>> NEW FILE DETECTED >>', path);
        sendToStream({ path });
      }
    })
    .on('change', (path) => {
      if (file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(path))) {
        logger.debug('>> FILE CHANGE DETECTED >>', path);
        sendToStream({ path });
      }
    })
    .on('unlink', (path) => {
      if (file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(path))) {
        logger.debug('>> FILE DELETE DETECTED >>', path);
        sendToStream({ path });
      }
    });

  return watcher;
}
