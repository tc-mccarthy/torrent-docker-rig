import exec_promise from './exec_promise';
import { aspect_round } from './base-config';
import { trash, escape_file_path } from './fs';
import logger from './logger';

export default async function ffprobe (file) {
  try {
    const ffprobeCMD = `ffprobe -v quiet -print_format json -show_format -show_chapters -show_streams "${escape_file_path(
      file
    )}"`;
    logger.info(ffprobeCMD, { label: 'FFPROBE COMMAND' });
    const { stdout, stderr } = await exec_promise(ffprobeCMD);

    logger.debug({ stdout, stderr }, { label: 'FFPROBE OUTPUT' });

    const data = JSON.parse(stdout);

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
