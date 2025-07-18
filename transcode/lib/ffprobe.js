import * as fs from 'fs';
import { spawn } from 'child_process';
import readline from 'readline';
import { aspect_round } from './base-config';
import { trash } from './fs';
import logger from './logger';

/**
 * Parses a frame rate string like "30000/1001" into a float.
 * @param {string} ratio - Frame rate as a string ratio.
 * @returns {number|null} - Parsed frame rate or null if invalid.
 */
function parseFrameRate (ratio) {
  try {
    if (typeof ratio !== 'string') return null;
    const [num, den] = ratio.split('/').map((v) => parseInt(v, 10));
    if (!den || Number.isNaN(num)) return null;
    return num / den;
  } catch {
    return null;
  }
}

/**
 * Fallback slow ffprobe call using -count_frames for accurate nb_frames.
 * @param {string} filePath - Media file path.
 * @returns {Promise<Object>} - Full ffprobe JSON output.
 */
async function ffprobe_with_count_frames (filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-count_frames',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      '-show_programs',
      '-print_format', 'json',
      filePath
    ];

    const ffprobe = spawn('ffprobe', args);
    const lines = [];

    const rl = readline.createInterface({
      input: ffprobe.stdout,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => lines.push(line));
    rl.on('close', () => {
      try {
        resolve(JSON.parse(lines.join('\n')));
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
      }
    });

    ffprobe.stderr.on('data', () => {});
    ffprobe.on('error', (err) => reject(new Error(`Failed to start ffprobe: ${err.message}`)));
    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
      }
    });
  });
}

/**
 * Runs ffprobe on the given media file and returns parsed JSON data.
 * Attempts to avoid -count_frames unless necessary.
 *
 * @param {string} filePath - Path to a media file.
 * @returns {Promise<Object>} - Parsed ffprobe data.
 */
export function ffprobe_promise (filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      '-show_programs',
      '-print_format', 'json',
      filePath
    ];

    const ffprobe = spawn('ffprobe', args);
    const lines = [];

    const rl = readline.createInterface({
      input: ffprobe.stdout,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => lines.push(line));

    rl.on('close', async () => {
      try {
        const json = JSON.parse(lines.join('\n'));

        const needsFallback = (json.streams || []).some((stream) => {
          if (stream.codec_type !== 'video') return false;

          if (!stream.nb_frames || stream.nb_frames === 'N/A') {
            const fps = parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate);
            let duration = parseFloat(stream.duration);

            if (Number.isNaN(duration) && json.format?.duration) {
              duration = parseFloat(json.format.duration);
            }

            if (!fps || Number.isNaN(duration)) return true;

            stream.nb_frames = Math.round(fps * duration).toString();
          }

          return false;
        });

        if (needsFallback) {
          const detailed = await ffprobe_with_count_frames(filePath);
          return resolve(detailed);
        }

        resolve(json);
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
      }
    });

    ffprobe.stderr.on('data', () => {});
    ffprobe.on('error', (err) => reject(new Error(`Failed to start ffprobe: ${err.message}`)));
    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
      }
    });
  });
}

export default async function ffprobe_func (file) {
  try {
    if (!fs.existsSync(file)) {
      return new Error(`File does not exist: ${file}`);
    }

    logger.info(`Probing ${file}`);
    const data = await ffprobe_promise(file);
    logger.info(`Probed ${file} successfully`);

    logger.debug(data, { label: 'FFProbe complete' });

    data.format.duration = +data.format.duration;
    data.format.size = +data.format.size;
    data.format.bit_rate = +data.format.bit_rate;
    data.format.size = +data.format.size / 1024;

    const video = data.streams.find((s) => s.codec_type === 'video');

    if (video.display_aspect_ratio) {
      const [width, height] = video.display_aspect_ratio.split(':');
      video.aspect = aspect_round(width / height);
    } else {
      video.aspect = aspect_round(video.width / video.height);
    }

    if (video.side_data_list?.dv_profile && video.side_data_list?.dv_profile < 8) {
      throw new Error(`Video not supported: Dolby Vision profile version is less than 8`);
    }

    return data;
  } catch (e) {
    if (/command\s+failed/gi.test(e.message)) {
      trash(file);
    }

    if (/video\s+not\s+supported/gi.test(e.message)) {
      trash(file);
    }

    logger.error('FFPROBE FAILED', e);
    return false;
  }
}
