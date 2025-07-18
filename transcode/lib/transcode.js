import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import dayjs from 'dayjs';
import { stat } from 'fs/promises';
import ffprobe from './ffprobe';
import config from './config';
import logger from './logger';
import { trash, generate_file_paths } from './fs';
import upsert_video from './upsert_video';
import ErrorLog from '../models/error';
import probe_and_upsert from './probe_and_upsert';
import wait from './wait';
import integrityCheck from './integrityCheck';
import generate_filelist from './generate_filelist';
import moveFile from './moveFile';
import update_status from './update_status';
import { generateTranscodeInstructions } from './generate_transcode_instructions';

const { encode_version } = config;

// function to format seconds to HH:mm:ss
export function formatSecondsToHHMMSS (totalSeconds) {
  if (Number.isNaN(totalSeconds)) return 'calculating';

  const total = Math.ceil(Number(totalSeconds)); // round up
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const pad = (n) => String(n).padStart(2, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export default function transcode (file) {
  return new Promise(async (resolve, reject) => {
    try {
      // mongo record of the video
      const video_record = file;
      file = file.path;

      if (!video_record || !video_record?._id) {
        throw new Error(`Video record not found for file: ${file}`);
      }

      const exists = fs.existsSync(file);

      if (!exists) {
        throw new Error(`File not found: ${file}`);
      }

      const ffprobe_data = await ffprobe(file);
      video_record.probe = ffprobe_data;

      const transcode_instructions = generateTranscodeInstructions(video_record);

      console.log('>> Transcode Instructions Generated <<');
      console.log(transcode_instructions);

      if (!transcode_instructions.video) {
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

        await video_record.saveDebounce();
        return resolve({ locked: true }); // mark locked as true so that the loop doesnt' delay the next start
      }

      // if the file hasn't already been integrity checked, do so now
      if (!video_record.integrityCheck) {
        logger.info(
          "File hasn't been integrity checked. Checking before transcode"
        );
        await integrityCheck(video_record);
      }

      const hwaccel = video_record.permitHWDecode ? 'auto' : 'none';

      const source_video_codec = ffprobe_data.streams.find((s) => s.codec_type === 'video')?.codec_name;
      const source_audio_codec = ffprobe_data.streams.find((s) => s.codec_type === 'audio')?.codec_name;
      const {audio_language} = video_record

      // start by mapping in the video stream and then all of the audio streams and then all of the subtitle streams
      const input_maps = [`-map 0:${transcode_instructions.video.stream_index}`]
        .concat(transcode_instructions.audio.map((audio) => `-map 0:${audio.stream_index}`))
        .concat(transcode_instructions.subtitles.map((subtitle) => `-map 0:${subtitle.stream_index}`));

      // if there are chapters, map them in
      if (ffprobe_data.chapters.length > 0) {
        input_maps.push(`-map_chapters 0`);
      }

      let cmd = ffmpeg(file).inputOptions(['-v fatal', '-stats', `-hwaccel ${hwaccel}`].filter((f) => f))
        .outputOptions(input_maps) // Map out the streams we want to preserve
        .outputOptions([ // Handle the video output options
          `-c:v ${transcode_instructions.video.codec}`,
          ...Object.keys(transcode_instructions.video.arguments || {}).map(
            (k) => `-${k} ${transcode_instructions.video.arguments[k]}`
          )
        ])
        .outputOptions([ // Handle the audio output options
          ...transcode_instructions.audio.map((audio, audio_idx) => `-c:a:${audio_idx} ${audio.codec} -b:a:${audio_idx} ${audio.bitrate} -map_metadata:s:a:${audio_idx} 0:s:a:${audio_idx}`)
        ])
        .outputOptions([ // Handle the subtitle output options
          ...transcode_instructions.subtitles.map((subtitle, sub_idx) => `-c:s:${sub_idx} ${subtitle.codec} -map_metadata:s:s:${sub_idx} 0:s:s:${sub_idx}`)
        ])
        .outputOptions([ // Handle the global metadata
          `-metadata encode_version=${encode_version}`
        ]);

      let ffmpeg_cmd;
      let start_time;
      const original_size = (await stat(file)).size;

      cmd = cmd
        .on('start', async (commandLine) => {
          logger.info(`Spawned Ffmpeg with command: ${commandLine}`);
          start_time = dayjs();
          ffmpeg_cmd = commandLine;

          generate_filelist({
            limit: 1000,
            writeToFile: true
          });

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
          const time_remaining = formatSecondsToHHMMSS(est_completed_seconds);
          const estimated_final_kb =
            (progress.targetSize / progress.percent) * 100;
          const output = JSON.stringify(
            {
              ...progress,
              source_audio_codec,
              source_video_codec,
              audio_language,
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
              ffmpeg_cmd,
              file
            },
            { label: 'Job' }
          );

          logger.debug(output);

          fs.writeFileSync(
            `/usr/app/output/active-${video_record._id}.json`,
            JSON.stringify({
              ffmpeg_cmd,
              audio_language: video_record.audio_language,
              file,
              output: JSON.parse(output)
            })
          );
        })
        .on('end', async (stdout, stderr) => {
          try {
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
            await moveFile(scratch_file, dest_file);

            // update the timestamp on the destination file so that it's picked up in scans
            await fs.promises.utimes(dest_file, new Date(), new Date());
            global.processed_files_delta += 1;

            // get the destination file size
            const dest_file_size = (await stat(dest_file)).size;

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
              },
              reclaimedSpace: original_size - dest_file_size // calculate reclaimed space
            });

            await update_status();
          } catch (e) {
            logger.error(e, { label: 'POST TRANSCODE ERROR' });
          } finally {
            resolve({});
          }
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
          await trash(scratch_file, false);
          // if the error message contains '251' disable the hardware acceleration
          if (/251/i.test(err.message)) {
            logger.warn(
              'FFmpeg error 251 detected. Disabling hardware acceleration for this video.'
            );
            video_record.permitHWDecode = false;
          }
          Object.assign(video_record, {
            error: {
              error: err.message,
              stdout,
              stderr,
              ffmpeg_cmd,
              trace: err.stack
            },
            hasError: true
          });
          await video_record.saveDebounce();

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
