import * as fs from 'fs';
import { spawn } from 'child_process';
import readline from 'readline';
import { aspect_round } from './base-config';
import { trash } from './fs';
import logger from './logger';

/**
 * Runs ffprobe on the given media file and returns parsed JSON data.
 * - Uses `child_process.spawn` to stream output line-by-line.
 * - Avoids memory overload by not including -show_frames or -show_packets.
 * - Includes container, stream, chapter, and program metadata.
 *
 * @param {string} filePath - Absolute or relative path to a video/audio file.
 * @returns {Promise<Object>} - Resolves with the parsed ffprobe output as a JSON object.
 */
export function ffprobe_promise (filePath) {
  return new Promise((resolve, reject) => {
    // ffprobe arguments to collect detailed, but safe, metadata
    const args = [
      '-v', 'error', // suppress non-error logs
      '-count_frames', // force counting actual frame numbers
      '-show_format', // return format/container-level info
      '-show_streams', // return data for video/audio/subtitle streams
      '-show_chapters', // include chapter metadata if present
      '-show_programs', // useful for MPEG-TS or complex containers
      '-print_format', 'json', // output as structured JSON
      filePath // input media file
    ];

    // Start ffprobe as a child process
    const ffprobe = spawn('ffprobe', args);

    // Buffer lines one-by-one to safely assemble JSON
    const lines = [];

    // Read stdout line-by-line using readline
    const rl = readline.createInterface({
      input: ffprobe.stdout,
      crlfDelay: Infinity
    });

    // Accumulate each line
    rl.on('line', (line) => {
      lines.push(line);
    });

    // When stream ends, parse full JSON
    rl.on('close', () => {
      try {
        const json = JSON.parse(lines.join('\n'));
        resolve(json);
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
      }
    });

    // Optional: collect stderr output (ignored here)
    ffprobe.stderr.on('data', (data) => {
      // Uncomment for debugging:
      // console.warn('ffprobe stderr:', data.toString());
    });

    // Handle spawn errors (e.g., binary not found)
    ffprobe.on('error', (err) => {
      reject(new Error(`Failed to start ffprobe: ${err.message}`));
    });

    // Handle non-zero exit codes
    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
      }
    });
  });
}

export default async function ffprobe_func (file) {
  try {
    // confirm the file exists
    if (!fs.existsSync(file)) {
      return new Error(`File does not exist: ${file}`);
    }

    const data = await ffprobe_promise(file);

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

    // mark the video as unsupported if it has a dv_profile value and that value is less than 8
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
