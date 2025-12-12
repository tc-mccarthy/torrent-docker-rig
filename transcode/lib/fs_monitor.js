import chokidar from 'chokidar';
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

async function receiveFromStream (callback) {
  let lastId = '0-0';
  while (true) {
    const response = await redisClient.xRead(
      [{ key: STREAM_KEY, id: lastId }],
      { BLOCK: 0, COUNT: 1 }
    );
    if (response && response.length > 0) {
      const [stream] = response;
      const ids = stream.messages.map((message) => {
        callback(message.id, message.message);
        return message.id;
      });
      if (ids.length > 0) {
        lastId = ids[ids.length - 1];
      }
    }
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

  receiveFromStream(async (id, message_content) => {
    try {
      logger.info(`Processing file system event for file: ${message_content.path}`, { label: 'REDIS STREAM READ', message_content });
      await probe_and_upsert(message_content.path);
    } catch (e) {
      logger.error(e, { label: 'REDIS STREAM READ ERROR' });
    }
  });

  return watcher;
}
