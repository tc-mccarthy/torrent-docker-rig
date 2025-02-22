import chokidar from 'chokidar';
import config from './config';
import rabbit_connect from './rabbitmq';
import logger from './logger';
import probe_and_upsert from './probe_and_upsert';

const { file_ext } = config;

const { get_paths } = config;

const PATHS = get_paths(config);

// connect to rabbit
const { send, receive } = await rabbit_connect();

export default function fs_watch () {
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
      logger.debug('>> WATCHER IS READY AND WATCHING >>', watcher.getWatched());
    })
    .on('error', (error) => logger.error(`Watcher error: ${error}`))
    .on('add', (path) => {
      if (file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(path))) {
        logger.debug('>> NEW FILE DETECTED >>', path);
        send({ path });
      }
    })
    .on('change', (path) => {
      if (file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(path))) {
        logger.debug('>> FILE CHANGE DETECTED >>', path);
        send({ path });
      }
    })
    .on('unlink', (path) => {
      if (file_ext.some((ext) => new RegExp(`.${ext}$`, 'i').test(path))) {
        logger.debug('>> FILE DELETE DETECTED >>', path);
        send({ path });
      }
    });

  receive(async (msg, message_content, channel) => {
    try {
      await probe_and_upsert(message_content.path);
      channel.ack(msg);
    } catch (e) {
      logger.error(e, { label: 'RABBITMQ ERROR' });
      channel.ack(msg);
    }
  });

  return watcher;
}
