import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import dayjs from 'dayjs';
import ffprobe from './ffprobe';
import config from './config';
import logger from './logger';
import { trash, generate_file_paths } from './fs';
import upsert_video from './upsert_video';
import ErrorLog from '../models/error';
import probe_and_upsert from './probe_and_upsert';
import wait from './wait';
import integrityCheck from './integrityCheck';

const { encode_version } = config;

export default function transcode (file) {
  return new Promise(async (resolve, reject) => {
    try {
      // mongo record of the video
      const video_record = file;
      file = file.path;

      if (!video_record || !video_record?._id) {
        throw new Error(`Video record not found for file: ${file}`);
      }

      const { profiles } = config;
      const exists = fs.existsSync(file);

      if (!exists) {
        throw new Error(`File not found: ${file}`);
      }

      const ffprobe_data = await ffprobe(file);

      logger.debug(ffprobe_data, { label: '>> FFPROBE DATA >>' });

      const video_stream = ffprobe_data.streams.find(
        (s) => s.codec_type === 'video'
      );

      if (!video_stream) {
        throw new Error('No video stream found');
      }

      const { scratch_file, dest_file } = generate_file_paths(file);

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
        await video_record.clearLock('transcode');
        await video_record.saveDebounce();
        return resolve({ locked: true }); // mark locked as true so that the loop doesnt' delay the next start
      }

      // get the audio stream, in english unless otherwise specified, with the highest channel count
      const audio_stream_test = new RegExp(
        (video_record.audio_language || ['und', 'eng']).join('|'),
        'i'
      );

      // preserve the audio lines specified in the video record, sorted by channel count
      const audio_streams = ffprobe_data.streams
        .filter(
          (s) =>
            s.codec_type === 'audio' &&
            (!s.tags?.language || audio_stream_test.test(s.tags.language))
        )
        .sort((a, b) => (a.channels > b.channels ? -1 : 1));

      if (!audio_streams?.length) {
        throw new Error('No audio stream found');
      }

      const map_metadata = [];

      const subtitle_streams = ffprobe_data.streams.filter(
        (s) =>
          s.codec_type === 'subtitle' &&
          s.tags?.language === 'eng' &&
          /subrip|hdmv_pgs_subtitle|substation/i.test(s.codec_name)
      );
      let transcode_video = false;
      let transcode_audio = false;
      let hwaccel = 'qsv';
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
        map_metadata.push(`-map_metadata:s:a:${idx} 0:s:a:${idx}`); // source the metadata from the original audio stream

        if (
          conversion_profile.output.audio.codec_name !== audio_stream.codec_name
        ) {
          transcode_audio = true;
          audio_filters.push(
            `-c:a:${idx} ${conversion_profile.output.audio.codec}`, // specify the codec for this audio stream on the output
            `-b:a:${idx} ${
              audio_stream.channels *
              conversion_profile.output.audio.per_channel_bitrate
            }k` // set the bitrate for this audio stream
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

      if (!/hevc|h264/i.test(video_stream.codec_name)) {
        // if the video is not HEVC or H264, disable hardware acceleration
        hwaccel = 'none';
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

      // if the video is 350mb or less in size and the codec is h264, don't transcode
      if (
        video_stream.codec_name === 'h264' &&
        ffprobe_data.format.size <= 350000
      ) {
        logger.debug(
          'Video stream codec is h264 and size is less than 350mb. Not transcoding'
        );
        transcode_video = false;
      }

      const input_maps = [`-map 0:${video_stream.index}`].concat(
        audio_streams.map((s) => `-map 0:${s.index}`)
      );

      if (subtitle_streams.length > 0) {
        subtitle_streams.forEach((s, idx) => {
          input_maps.push(`-map 0:${s.index}`);
          map_metadata.push(`-map_metadata:s:s:${idx} 0:s:s:${idx}`); // source the metadata from the original audio stream
        });

        input_maps.push('-c:s copy');
      }

      if (ffprobe_data.chapters.length > 0) {
        input_maps.push(`-map_chapters 0`);
      }

      // need to lock before doing the integrity check
      await video_record.setLock('transcode');

      // if the file hasn't already been integrity checked, do so now
      if (!video_record.integrityCheck) {
        logger.info(
          "File hasn't been integrity checked. Checking before transcode"
        );
        await integrityCheck(video_record);
      }

      if (!transcode_video) {
        video_record.computeScore = 0.2; // set the compute score to 0.2 because we're not transcoding
      }

      if (!transcode_audio) {
        video_record.computeScore -= 0.1; // reduce 0.1 from the compute score because we're not transcoding audio
      }

      let cmd = ffmpeg(file);

      cmd = cmd
        .inputOptions(['-v fatal', '-stats', `-hwaccel ${hwaccel}`].filter((f) => f)) // use hardware acceleration if not transcoding video
        .outputOptions(input_maps);

      if (transcode_video) {
        // handle HDR
        if (/arib[-]std[-]b67|smpte2084/i.test(video_stream.color_transfer)) {
          conversion_profile.name += ` (hdr)`; // add HDR to the profile name
        }

        cmd = cmd.outputOptions([
          `-c:v ${conversion_profile.output.video.codec}`,
          ...Object.keys(conversion_profile.output.video.flags || {}).map(
            (k) => `-${k} ${conversion_profile.output.video.flags[k]}`
          ),
          ...map_metadata
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
            await video_record.saveDebounce();
          }
        })
        .on('progress', (progress) => {
          const elapsed = dayjs().diff(start_time, 'seconds');
          const run_time = dayjs.utc(elapsed * 1000).format('HH:mm:ss');
          const pct_per_second = progress.percent / elapsed;
          const seconds_pct = 1 / pct_per_second;
          const pct_remaining = 100 - progress.percent;
          const est_completed_seconds = pct_remaining * seconds_pct;
          const time_remaining = dayjs
            .utc(est_completed_seconds * 1000)
            .format(
              [est_completed_seconds > 86400 && 'D:', 'HH:mm:ss']
                .filter((t) => t)
                .join('')
            );
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
              computeScore: video_record.computeScore,
              priority: video_record.sortFields.priority,
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
              },
              action: 'transcode'
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
          try {
            await video_record.clearLock('transcode');
            logger.info('Transcoding succeeded!');
            logger.info(`Confirming existence of ${scratch_file}`);

            await wait(5);
            if (!fs.existsSync(scratch_file)) {
              fs.writeFileSync(
                `/usr/app/output/final-${video_record._id}.json`,
                JSON.stringify({ stdout, stderr }, true, 4)
              );
              throw new Error(
                `Scratch file ${scratch_file} not found after transcode complete. View log /usr/app/output/final-${video_record._id}.json`
              );
            }

            logger.info(`${scratch_file} found by nodejs`);

            // rename the scratch file to the destination file name
            await fs.promises.rename(scratch_file, dest_file);

            // update the timestamp on the destination file so that it's picked up scans
            await fs.promises.utimes(dest_file, new Date(), new Date());

            // delete the original file if the transcoded filename is different
            if (dest_file !== file) {
              logger.info(
                'Destination filename and file name differ. Deleting original file',
                { dest_file, file }
              );
              await trash(file, false);
            }

            await probe_and_upsert(dest_file, video_record._id, {
              transcode_details: {
                ...video_record.transcode_details,
                end_time: dayjs().toDate(),
                duration: dayjs().diff(start_time, 'seconds')
              }
            });
            await video_record.clearLock('transcode');
          } catch (e) {
            logger.error(e, { label: 'POST TRANSCODE ERROR' });
          } finally {
            resolve({});
          }
        })
        .on('error', async (err, stdout, stderr) => {
          await video_record.clearLock('transcode');
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
          await trash(scratch_file, false);
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
          await video_record.clearLock('transcode');

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

          resolve({});
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

      resolve({});
    }
  });
}
