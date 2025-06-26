import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import dayjs from 'dayjs';
import File from '../models/files';
import ffprobe from './ffprobe';
import config from './config';
import logger from './logger';
import { trash } from './fs';
import IntegrityError from '../models/integrityError';

const { encode_version } = config;

function get_error_list (stderr) {
  const exceptions = [/speed[=]/i, /dts/i, /last\s+message\s+repeated/i, /referenced\s+qt\s+chapter\s+track\s+not\s+found/i];

  const all_errors = stderr
    .toLowerCase()
    .split('\n')
    .map((error) => error.trim()) // trim each error
    .filter((error) => error); // remove empty errors

  const errors_that_matter = all_errors.filter(
    (error) => !exceptions.some((exception) => exception.test(error))
  ); // only those errors that do not contain any excepted phrases

  return errors_that_matter;
}

function integrity_check_pass ({ stderr }) {
  const errors = get_error_list(stderr);
  return errors.length === 0;
}

export default function integrityCheck (file) {
  return new Promise(async (resolve, reject) => {
    try {
      // mongo record of the video
      logger.info(file, { label: 'INTEGRITY CHECKING FILE' });

      const video_record = file;
      file = file.path;

      // if the file is locked, short circuit
      if (await video_record.hasLock()) {
        logger.info(
          `File is locked. Skipping integrity check: ${file} - ${video_record._id}`
        );
        return resolve();
      }

      await video_record.setLock('integrity');

      const exists = fs.existsSync(file);

      if (!exists) {
        throw new Error(`File not found: ${file}`);
      }

      const ffprobe_data = await ffprobe(file);

      const video_stream = ffprobe_data.streams.find(
        (s) => s.codec_type === 'video'
      );

      if (!video_stream) {
        throw new Error('No video stream found');
      }

      // if this file has already been encoded, short circuit
      if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
        logger.debug(
          {
            file,
            encode_version: ffprobe_data.format.tags?.ENCODE_VERSION,
            integrityCheck: true
          },
          { label: 'File already encoded' }
        );
        video_record.encode_version = ffprobe_data.format.tags?.ENCODE_VERSION;
        video_record.integrityCheck = true;
        video_record.status = 'complete';
        await video_record.clearLock('integrity');
        await video_record.saveDebounceDebounce();
        return resolve();
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

      let start_time;
      let ffmpeg_cmd;
      const conversion_profile = {};

      ffmpeg(file)
        .inputOptions(['-v fatal', '-stats'])
        .outputOptions([
          '-c:v copy',
          '-c:a copy',
          '-f null'
        ])
        .on('start', async (commandLine) => {
          logger.debug(`Spawned integrity check with command: ${commandLine}`);
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
              action: 'verify'
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
            await video_record.clearLock('integrity');
            logger.debug('FFMPEG INTEGRITY CHECK COMPLETE', { stdout, stderr });
            if (integrity_check_pass({ stderr })) {
              logger.debug('No disqualifying errors found');
              video_record.integrityCheck = true;
              await video_record.clearLock('integrity');
              await video_record.saveDebounce();
            } else {
              logger.debug('OUTPUT DETECTED, ERRORS MUST HAVE BEEN FOUND');
              IntegrityError.create({
                path: file,
                stdout,
                stderr,
                errors: get_error_list(stderr)
              });
              trash(file);
              await File.deleteOne({ path: file });
            }
          } catch (e) {
            logger.error(e, { label: 'POST INTEGRITY CHECK ERROR' });
          } finally {
            resolve();
          }
        })
        .on('error', async (err, stdout, stderr) => {
          await video_record.clearLock('transcode');
          logger.error(err, {
            label: 'Cannot process video during integrity check',
            stdout,
            stderr
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

            IntegrityError.create({
              path: file,
              stdout,
              stderr
            });
          }
          resolve();
        })
        .save('-');
    } catch (e) {
      logger.error(e, { label: 'INTEGRITY CHECK ERROR' });

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
