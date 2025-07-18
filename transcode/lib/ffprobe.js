import * as fs from 'fs';
import { ffprobe } from 'fluent-ffmpeg';
import { aspect_round } from './base-config';
import { trash } from './fs';
import logger from './logger';

export function ffprobe_promise (file) {
  return new Promise((resolve, reject) => {
    logger.debug(file, {
      label: 'Probing file using ffprobe method from fluent-ffmpeg wrapper'
    });
    ffprobe(file, (err, data) => {
      if (err) {
        logger.error('FFPROBE FAILED', err);
        return reject(err);
      }
      resolve(data);
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
