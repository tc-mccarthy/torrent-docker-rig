import fs from 'fs';
import dayjs from './dayjs';
import ffprobe from './ffprobe';
import upsert_video from './upsert_video';
import { trash } from './fs';
import tmdb_api from './tmdb_api';
import File from '../models/files';
import language_map from './lang';
import config from './config';

const { encode_version } = config;

export default async function probe_and_upsert (file, record_id, opts = {}) {
  file = file.replace(/\n+$/, '');
  try {
    const current_time = dayjs();

    // check if the file exists
    if (!fs.existsSync(file)) {
      throw new Error('File not found');
    }

    const video_record = await File.findOne({ path: file });

    const ffprobe_data = await ffprobe(file);

    let languages = ['en', 'und'];

    if (video_record?.audio_language?.length) {
      languages = languages.concat(video_record.audio_language);
    }

    const tmdb_data = await tmdb_api(file);

    if (tmdb_data.spoken_languages) {
      languages = languages.concat(
        tmdb_data.spoken_languages.map((l) => l.iso_639_1)
      );
    }

    // map the ISO 639-1 language codes to 639-2 but preserve the original as well
    languages = languages
      .map((l) => {
        const response = [l];

        if (language_map[l]) {
          response.push(language_map[l]);
        }

        return response;
      })
      .reduce((acc, val) => acc.concat(val), [])
      .reduce((acc, val) => (acc.includes(val) ? acc : acc.concat(val)), []);

    await upsert_video({
      record_id,
      path: file,
      probe: ffprobe_data,
      encode_version: ffprobe_data.format.tags?.ENCODE_VERSION,
      status: ffprobe_data.format.tags?.ENCODE_VERSION === encode_version ? 'complete' : 'pending',
      last_probe: current_time,
      sortFields: {
        width: ffprobe_data.streams.find((s) => s.codec_type === 'video')
          ?.width,
        size: ffprobe_data.format.size
      },
      audio_language: languages,
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
