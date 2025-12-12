import chokidar from 'chokidar';
import async from 'async';
import { setTimeout as delay } from 'timers/promises';
import config from './config';
import redisClient from './redis';
import logger from './logger';
import probe_and_upsert from './probe_and_upsert';

const { file_ext } = config;

const { get_paths } = config;

const PATHS = get_paths(config);

const STREAM_KEY = 'transcode_file_events_20251212a';

async function sendToStream (msg) {
  try {
    logger.info(msg, { label: 'REDIS STREAM SEND' });
    const result = await redisClient.xAdd(STREAM_KEY, '*', { ...msg });
    logger.info(`Message added to stream with ID: ${result}`, { label: 'REDIS STREAM SEND' });
  } catch (e) {
    logger.error(e, { label: 'REDIS STREAM SEND ERROR' });
  }
}

export async function processFSEventQueue () {
  try {
    logger.info(`About to call xRead for stream '${STREAM_KEY}'`, { label: 'REDIS STREAM RECEIVE' });
    const response = await redisClient.xRead(
      [{ key: STREAM_KEY, id: '0-0' }],
      { BLOCK: 5000, COUNT: 1 }
    );
    logger.info({ response }, { label: 'REDIS STREAM READ RESPONSE' });

    if (response && response.length > 0) {
      const [stream] = response;
      const messages = stream.messages;
      logger.info(`xRead returned ${messages.length} messages`, { label: 'REDIS STREAM READ RESPONSE' });
      await async.eachSeries(messages, async ({ message, id }) => {
        try {
          logger.info({ message, STREAM_KEY }, { label: 'REDIS STREAM READ' });
          await probe_and_upsert(message.path);
          await redisClient.xTrim(STREAM_KEY, 'MINID', id);
        } catch (e) {
          logger.error(e, { label: 'REDIS STREAM READ LOOP ERROR' });
        } finally {
          return true;
        }
      });
    } else {
      logger.info('xRead returned no messages (timeout or empty stream)', { label: 'REDIS STREAM READ RESPONSE' });
    }
  } catch (e) {
    logger.error(e, { label: 'REDIS STREAM RECEIVE ERROR' });
  } finally {
    // 5-second cool-off before next pass
    await delay(5000);
    // Continue processing from the last ID
    processFSEventQueue();
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

  // Debounce map: path -> timer
  const debounceTimers = new Map();
  const DEBOUNCE_MS = 10000; // 10 seconds

  function debounceSend (path) {
    if (debounceTimers.has(path)) {
      clearTimeout(debounceTimers.get(path));
    }
    debounceTimers.set(path, setTimeout(() => {
      logger.debug('>> DEBOUNCED FILE EVENT >>', path);
      sendToStream({ path });
      debounceTimers.delete(path);
    }, DEBOUNCE_MS));
  }

  watcher
    .on('ready', () => {
      logger.debug('>> WATCHER IS READY AND WATCHING >>', watcher.getWatched());
      logger.info('File system monitor is now watching for changes.', { label: 'FS MONITOR READY' });
    })
    .on('error', (error) => logger.error(`Watcher error: ${error}`))
    .on('add', (path) => {
      if (file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(path))) {
        logger.debug('>> NEW FILE DETECTED >>', path);
        debounceSend(path);
      }
    })
    .on('change', (path) => {
      if (file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(path))) {
        logger.debug('>> FILE CHANGE DETECTED >>', path);
        debounceSend(path);
      }
    })
    .on('unlink', (path) => {
      if (file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(path))) {
        logger.debug('>> FILE DELETE DETECTED >>', path);
        debounceSend(path);
      }
    });

  return watcher;
}
