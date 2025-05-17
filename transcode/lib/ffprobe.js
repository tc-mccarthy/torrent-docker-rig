import * as fs from 'fs';
import { aspect_round } from './base-config';
import { trash } from './fs';
import logger from './logger';
import {ffprobe} from 'fluent-ffmpeg'

export function ffprobe_promise(file){
  return new Promise((resolve, reject) => {
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
    if(!fs.existsSync(file)){
      return new Error(`File does not exist: ${file}`);
    }

    const data = await ffprobe_promise(file);

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

    return data;
  } catch (e) {
    if (/command\s+failed/gi.test(e.message)) {
      trash(file);
    }
    logger.error('FFPROBE FAILED', e);
    return false;
  }
}
