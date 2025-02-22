import fs from 'fs';
import dayjs from './dayjs';
import ffprobe from './ffprobe';
import upsert_video from './upsert_video';
import { trash } from './fs';

export default async function probe_and_upsert (file, record_id, opts = {}) {
  file = file.replace(/\n+$/, '');
  try {
    const current_time = dayjs();

    // check if the file exists
    if (!fs.existsSync(file)) {
      throw new Error('File not found');
    }

    const ffprobe_data = await ffprobe(file);

    await upsert_video({
      record_id,
      path: file,
      probe: ffprobe_data,
      encode_version: ffprobe_data.format.tags?.ENCODE_VERSION,
      last_probe: current_time,
      sortFields: {
        width: ffprobe_data.streams.find((s) => s.codec_type === 'video')
          ?.width,
        size: ffprobe_data.format.size
      },
      ...opts
    });

    return ffprobe_data;
  } catch (e) {
    // if the file wasn't found
    if (/file\s+not\s+found/gi.test(e.message)) {
      await trash(file);
    }

    return false;
  }
}
