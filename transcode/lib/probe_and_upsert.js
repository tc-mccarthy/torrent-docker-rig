import fs from 'fs';
import crypto from 'crypto';
import dayjs from './dayjs';
import ffprobe from './ffprobe';
import upsert_video from './upsert_video';
import { trash } from './fs';
import tmdb_api from './tmdb_api';
import File from '../models/files';
import language_map from './lang';
import config from './config';
import logger from './logger';

const { encode_version } = config;

/**
 * Computes a SHA-256 hash of the given file as a hex string.
 * @param {string} filePath - Path to the file to hash.
 * @returns {Promise<string>} - Hex-encoded hash string.
 */
function hashFile (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('error', reject);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

/**
 * Probes the video file, collects language and metadata, and upserts it into MongoDB.
 * If the file has already been processed and its hash hasn't changed, probing is skipped.
 *
 * @param {string} file - Path to the video file.
 * @param {string} record_id - Optional known record ID to associate with.
 * @param {Object} opts - Optional additional properties to attach to the record.
 * @returns {Promise<Object|false>} - ffprobe result or false if failed/skipped.
 */
export default async function probe_and_upsert (file, record_id, opts = {}) {
  file = file.replace(/\n+$/, '');
  try {
    logger.info(`Probe and upsert on file`, { file });
    const current_time = dayjs();

    if (!fs.existsSync(file)) {
      throw new Error('File not found');
    }

    logger.info(`Getting video record`, { file });
    const video_record = await File.findOne({ path: file });

    // Hash the current file contents
    logger.info(`Hashing file`, { file });
    const current_hash = await hashFile(file);

    // If the file has already been processed and hash matches, skip probing
    if (video_record?.file_hash === current_hash && video_record?.probe) {
      logger.info(`File record already exists and hash hasn't changed. Skipping probe`);
      return video_record.probe;
    }

    logger.info(`Probing file`, { file });
    const ffprobe_data = await ffprobe(file);

    logger.info(`Getting API data`, { file });
    const tmdb_data = await tmdb_api(file);

    let languages = ['en', 'und'];

    if (video_record?.audio_language?.length) {
      languages = languages.concat(video_record.audio_language);
    }

    if (tmdb_data.spoken_languages) {
      languages = languages.concat(
        tmdb_data.spoken_languages.map((l) => l.iso_639_1)
      );
    }

    // Normalize and deduplicate languages
    languages = languages
      .map((l) => [l, language_map[l]].filter(Boolean))
      .flat()
      .filter((v, i, arr) => arr.indexOf(v) === i);

    logger.info(`Upserting file`, { file });

    await upsert_video({
      record_id,
      path: file,
      file_hash: current_hash, // Save the hash to detect future changes
      probe: ffprobe_data,
      encode_version: ffprobe_data.format.tags?.ENCODE_VERSION,
      status: ffprobe_data.format.tags?.ENCODE_VERSION === encode_version ? 'complete' : 'pending',
      last_probe: current_time,
      sortFields: {
        width: ffprobe_data.streams.find((s) => s.codec_type === 'video')?.width,
        size: ffprobe_data.format.size
      },
      audio_language: languages,
      ...opts
    });

    logger.info(`File upserted successfully`, { file });
    return ffprobe_data;
  } catch (e) {
    if (/file\s+not\s+found/gi.test(e.message)) {
      await trash(file);
    }

    logger.error(`Probe and upsert failed for ${file}`, { error: e });
    return false;
  }
}
