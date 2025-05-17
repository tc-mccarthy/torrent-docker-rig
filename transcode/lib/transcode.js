import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import dayjs from 'dayjs';
import File from '../models/files';
import ffprobe from './ffprobe';
import config from './config';
import logger from './logger';
import memcached from './memcached';
import { trash, escape_file_path } from './fs';
import exec_promise from './exec_promise';
import upsert_video from './upsert_video';
import ErrorLog from '../models/error';
import probe_and_upsert from './probe_and_upsert';

const { encode_version } = config;

export default function transcode (file) {
  return new Promise(async (resolve, reject) => {
    try {
      const { profiles } = config;
      // mongo record of the video
      const video_record = await File.findOne({ path: file });
      const exists = fs.existsSync(file);
      const locked = await memcached.get(`transcode_lock_${video_record._id}`);

      if (!exists) {
        throw new Error('File not found');
      }

      // if the file is locked, short circuit
      if (locked) {
        return resolve();
      }

      const ffprobe_data = await ffprobe(file);

      logger.debug(ffprobe_data, { label: 'FFPROBE DATA >>' });

      const video_stream = ffprobe_data.streams.find(
        (s) => s.codec_type === 'video'
      );

      if (!video_stream) {
        throw new Error('No video stream found');
      }

      // get the scratch path
      const scratch_path = config.sources.find((p) =>
        file.startsWith(p.path)).scratch;

      // get the filename
      const filename = file.match(/([^/]+)$/)[1];

      // set the scratch file path and name
      const scratch_file = `${scratch_path}/${filename}`.replace(
        /\.[A-Za-z0-9]+$/,
        '-optimized.tc.mkv'
      );

      // set the destination file path and name
      const dest_file = file.replace(/\.[A-Za-z0-9]+$/, '.mkv');

      // if this file has already been encoded, short circuit
      if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
        logger.info(
          {
            file,
            encode_version: ffprobe_data.format.tags?.ENCODE_VERSION
          },
          { label: 'File already encoded' }
        );
        video_record.encode_version = ffprobe_data.format.tags?.ENCODE_VERSION;
        await video_record.save();
        return resolve();
      }

      // get the audio stream, in english unless otherwise specified, with the highest channel count
      const audio_stream_test = new RegExp(
        (video_record.audio_language || ['und', 'eng']).join('|'),
        'i'
      );

      // preserve the audio lines specified in the video record, sorted by channel count
      const audio_streams = ffprobe_data.streams.filter(
        (s) =>
          s.codec_type === 'audio' &&
          (!s.tags?.language || audio_stream_test.test(s.tags.language))
      ).sort((a, b) => (a.channels > b.channels ? -1 : 1));

      if (!audio_streams?.length) {
        throw new Error('No audio stream found');
      }

      const subtitle_streams = ffprobe_data.streams.filter(
        (s) =>
          s.codec_type === 'subtitle' &&
          s.tags?.language === 'eng' &&
          /subrip|hdmv_pgs_subtitle|substation/i.test(s.codec_name)
      );
      let transcode_video = false;
      let transcode_audio = false;
      const video_filters = [];
      const audio_filters = [];

      const conversion_profile = config.get_profile(video_stream);

      logger.debug(
        {
          video_stream_width: video_stream.width,
          video_stream_aspect: video_stream.aspect,
          conversion_profile,
          profiles
        },
        { label: 'Profile debug info' }
      );

      conversion_profile.width =
        conversion_profile.dest_width || conversion_profile.width;

      // if the video codec doesn't match the profile
      if (
        conversion_profile.output.video.codec_name !== video_stream.codec_name
      ) {
        transcode_video = true;
      }

      // add transcode instructions for any audio streams that don't match the profile
      audio_streams.forEach((audio_stream, idx) => {
        if (
          conversion_profile.output.audio.codec_name !== audio_stream.codec_name
        ) {
          transcode_audio = true;
          audio_filters.push(
            `-c:a:${idx} ${conversion_profile.output.audio.codec}`,
            `-b:a:${idx} ${
              audio_stream.channels *
              conversion_profile.output.audio.per_channel_bitrate
            }k`
          );
        }
      });

      // if the video codec matches the profile, but the bitrate is higher than the profile
      if (
        ffprobe_data.format.bit_rate >
          conversion_profile.bitrate * 1024 * 1024 &&
        !transcode_video
      ) {
        logger.debug(
          'Video stream bitrate higher than conversion profile. Transcoding'
        );
        transcode_video = true;
      }

      // if the video is 1gb or less in size and the codec is HEVC, don't transcode
      if (
        video_stream.codec_name === 'hevc' &&
        ffprobe_data.format.size <= 1048576
      ) {
        logger.debug(
          'Video stream codec is HEVC and size is less than 1GB. Not transcoding'
        );
        transcode_video = false;
      }

      // if the input stream width doesn't equal the conversion profile width
      /* if (video_stream.width !== conversion_profile.width) {
        transcode_video = true;
        video_filters.push(
          `scale=${conversion_profile.width}:-2:flags=lanczos`
        );
      } */

      const input_maps = [
        `-map 0:${video_stream.index}`
      ].concat(audio_streams.map((s) => `-map 0:${s.index}`));

      if (subtitle_streams.length > 0) {
        subtitle_streams.forEach((s) => {
          input_maps.push(`-map 0:${s.index}`);
        });

        input_maps.push('-c:s copy');
      }

      if (ffprobe_data.chapters.length > 0) {
        input_maps.push(`-map_chapters 0`);
      }

      let cmd = ffmpeg(file);

      cmd = cmd.outputOptions(input_maps);

      if (transcode_video) {
        // const pix_fmt =
        // video_stream.pix_fmt === "yuv420p" ? "yuv420p" : "yuv420p10le";
        const pix_fmt = 'yuv420p10le';

        conversion_profile.output.video.addFlags({
          maxrate: `${conversion_profile.output.video.bitrate}M`,
          bufsize: `${conversion_profile.output.video.bitrate * 3}M`,
          max_muxing_queue_size: 9999,
          pix_fmt
        });

        // handle HDR
        if (/arib[-]std[-]b67|smpte2084/i.test(video_stream.color_transfer)) {
          conversion_profile.name += ` (hdr)`; // add HDR to the profile name
        }

        cmd = cmd.outputOptions([
          `-c:v ${conversion_profile.output.video.codec}`,
          ...Object.keys(conversion_profile.output.video.flags || {}).map(
            (k) => `-${k} ${conversion_profile.output.video.flags[k]}`
          )
        ]);
      } else {
        cmd = cmd.outputOptions('-c:v copy');
      }

      if (video_filters.length > 0) {
        cmd = cmd.outputOptions(['-vf', ...video_filters]);
      }

      if (!transcode_audio) {
        cmd = cmd.outputOptions('-c:a copy');
      } else {
        // add unique audio filters to output options
        cmd = cmd.outputOptions(
          audio_filters.filter((prop, idx, self) => self.indexOf(prop) === idx)
        );
      }

      cmd = cmd.outputOptions(`-metadata encode_version=${encode_version}`);

      let ffmpeg_cmd;

      let start_time;

      cmd = cmd
        .on('start', async (commandLine) => {
          logger.info(`Spawned Ffmpeg with command: ${commandLine}`);
          start_time = dayjs();
          ffmpeg_cmd = commandLine;

          if (video_record) {
            logger.debug('>> VIDEO FOUND -- REMOVING ERROR >>', video_record);
            video_record.error = undefined;
            video_record.transcode_details = {
              start_time: start_time.toDate(),
              source_codec: `${
                video_record.probe.streams.find((f) => f.codec_type === 'video')
                  ?.codec_name
              }_${
                video_record.probe.streams.find((f) => f.codec_type === 'audio')
                  ?.codec_name
              }`
            };
            await video_record.save();
          }
        })
        .on('progress', (progress) => {
          // set a 20 second lock on the video record
          memcached.set(`transcode_lock_${video_record._id}`, 'locked', 5);
          const elapsed = dayjs().diff(start_time, 'seconds');
          const run_time = dayjs.utc(elapsed * 1000).format('HH:mm:ss');
          const pct_per_second = progress.percent / elapsed;
          const seconds_pct = 1 / pct_per_second;
          const pct_remaining = 100 - progress.percent;
          const est_completed_seconds = pct_remaining * seconds_pct;
          const time_remaining = dayjs
            .utc(est_completed_seconds * 1000)
            .format('HH:mm:ss');
          const estimated_final_kb =
            (progress.targetSize / progress.percent) * 100;
          const output = JSON.stringify(
            {
              ...progress,
              video_stream,
              audio_streams,
              audio_language: video_record.audio_language,
              run_time,
              pct_per_second,
              pct_remaining,
              time_remaining,
              est_completed_seconds,
              size: {
                progress: {
                  kb: progress.targetSize,
                  mb: progress.targetSize / 1024,
                  gb: progress.targetSize / 1024 / 1024
                },
                estimated_final: {
                  kb: estimated_final_kb,
                  mb: estimated_final_kb / 1024,
                  gb: estimated_final_kb / 1024 / 1024,
                  change: `${
                    ((estimated_final_kb - ffprobe_data.format.size) /
                      ffprobe_data.format.size) *
                    100
                  }%`
                },
                original: {
                  kb: ffprobe_data.format.size,
                  mb: ffprobe_data.format.size / 1024,
                  gb: ffprobe_data.format.size / 1024 / 1024
                }
              }
            },
            true,
            4
          );
          console.clear();
          logger.debug(
            {
              ...conversion_profile,
              ffmpeg_cmd,
              file
            },
            { label: 'Job' }
          );

          logger.debug(output);

          fs.writeFileSync(
            `/usr/app/output/active-${video_record._id}.json`,
            JSON.stringify({
              ...conversion_profile,
              ffmpeg_cmd,
              audio_streams,
              video_stream,
              audio_language: video_record.audio_language,
              file,
              output: JSON.parse(output)
            })
          );
        })
        .on('end', async (stdout, stderr) => {
          logger.info('Transcoding succeeded!');

          // delete the original file
          await trash(file);

          // move the transcoded file to the destination and touch it so it's picked up by scans
          await exec_promise(
            `mv "${escape_file_path(scratch_file)}" "${escape_file_path(
              dest_file
            )}" && touch "${escape_file_path(dest_file)}"`
          );

          await probe_and_upsert(dest_file, video_record._id, {
            transcode_details: {
              ...video_record.transcode_details,
              end_time: dayjs().toDate(),
              duration: dayjs().diff(start_time, 'seconds')
            }
          });
          resolve();
        })
        .on('error', async (err, stdout, stderr) => {
          logger.error(err, { label: 'Cannot process video', stdout, stderr });
          fs.appendFileSync(
            '/usr/app/logs/ffmpeg.log',
            JSON.stringify(
              {
                error: err.message,
                stdout,
                stderr,
                ffmpeg_cmd,
                trace: err.stack
              },
              true,
              4
            )
          );
          await trash(scratch_file);
          await upsert_video({
            path: file,
            error: {
              error: err.message,
              stdout,
              stderr,
              ffmpeg_cmd,
              trace: err.stack
            },
            hasError: true
          });

          await ErrorLog.create({
            path: file,
            error: {
              error: err.message,
              stdout,
              stderr,
              ffmpeg_cmd,
              trace: err.stack
            }
          });

          const corrupt_video_tests = [
            {
              test: /Invalid\s+NAL\s+unit\s+size/gi,
              message: 'Invalid NAL unit size',
              obj: stderr
            },
            {
              test: /unspecified\s+pixel\s+format/gi,
              message: 'Unspecified pixel format',
              obj: stderr
            },
            {
              test: /unknown\s+codec/gi,
              message: 'Unknown codec',
              obj: stderr
            },
            {
              test: /too\s+many\s+packets\s+buffered\s+for\s+output\s+stream/gi,
              message: 'Too many packets buffered for output stream',
              obj: stderr
            },
            {
              test: /invalid\s+data\s+found\s+when\s+processing\s+input/gi,
              message: 'Invalid data found when processing input',
              obj: stderr
            },
            {
              test: /could\s+not\s+open\s+encoder\s+before\s+eof/gi,
              message: 'Could not open encoder before End of File',
              obj: stderr
            },
            {
              test: /command\s+failed/gi,
              message: 'FFProbe command failed, video likely corrupt',
              obj: stderr
            },
            {
              test: /ffmpeg\s+was\s+killed\s+with\s+signal\s+SIGFPE/i,
              message: 'FFMpeg processing failed, video likely corrupt',
              obj: stderr
            },
            {
              test: /[-]22/i,
              message: 'Unrecoverable Errors were found in the source',
              obj: stderr
            }
          ];

          const is_corrupt = corrupt_video_tests.find((t) =>
            t.test.test(t.obj));

          // If this video is corrupted, trash it
          if (is_corrupt) {
            logger.info(is_corrupt, {
              label: 'Source video is corrupt. Trashing'
            });
            // don't await the delete in case the problem is a missing file
            trash(file);
            await File.deleteOne({ path: file });
          }
          resolve();
        });
      cmd.save(scratch_file);
    } catch (e) {
      logger.error(e, { label: 'TRANSCODE ERROR' });
      await upsert_video({
        path: file,
        error: { error: e.message, trace: e.stack },
        hasError: true
      });

      await ErrorLog.create({
        path: file,
        error: { error: e.message, trace: e.stack }
      });

      if (/no\s+(video|audio)\s+stream\s+found/gi.test(e.message)) {
        await trash(file);
      }

      if (/file\s+not\s+found/gi.test(e.message)) {
        await trash(file);
      }

      resolve();
    }
  });
}
