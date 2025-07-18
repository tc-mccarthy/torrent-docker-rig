/**
 * @module Transcode
 * @description
 * This module performs hardware-accelerated, metadata-preserving video transcoding using FFmpeg.
 * It supports dynamic instruction generation based on source video metadata, including frame-accurate
 * progress tracking and file sanitation. Transcoding status and metrics are streamed to
 * disk in JSON for real-time external monitoring.
 *
 * This code was developed by TC, with enhancements assisted by ChatGPT from OpenAI, including:
 * - Frame-based progress percentage
 * - Modularized transcode instructions
 * - Improved error tracing and logging
 *
 * You are welcome to use, modify, and share. Please keep these comments if you find them helpful.
 */

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
const LOG_THROTTLE_MS = 10000; // Throttle progress updates to every 10 seconds

// Converts seconds into a zero-padded HH:mm:ss string
export function formatSecondsToHHMMSS (totalSeconds) {
  if (Number.isNaN(totalSeconds)) return 'calculating';

  const total = Math.ceil(Number(totalSeconds)); // round up
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const pad = (n) => String(n).padStart(2, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// Main transcode function exposed by the module
export default function transcode (file) {
  return new Promise(async (resolve) => {
    try {
      const video_record = file;
      file = file.path;

      logger.info(`Transcoding file: ${file}`, { label: 'Transcode' });

      // Validate input and presence of Mongo record
      if (!video_record || !video_record?._id) {
        throw new Error(`Video record not found for file: ${file}`);
      }

      if (!fs.existsSync(file)) {
        throw new Error(`File not found: ${file}`);
      }

      // Probe the input video and attach metadata to record
      let ffprobe_data = video_record.probe;

      if (!ffprobe_data) {
        ffprobe_data = await ffprobe(file);
        video_record.probe = ffprobe_data;
        await video_record.saveDebounce();
      }

      const transcode_instructions = generateTranscodeInstructions(video_record);
      logger.info(transcode_instructions, { label: 'Transcode Instructions' });

      if (!transcode_instructions.video) {
        throw new Error('No video stream found');
      }

      const { scratch_file, dest_file } = generate_file_paths(file);

      // Short-circuit if this encode version already exists
      if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
        logger.info({ file, encode_version }, { label: 'File already encoded' });
        video_record.encode_version = ffprobe_data.format.tags?.ENCODE_VERSION;
        await video_record.saveDebounce();
        return resolve({ locked: true });
      }

      // Check file integrity if not previously validated
      if (!video_record.integrityCheck) {
        logger.info("File hasn't been integrity checked. Checking before transcode");
        await integrityCheck(video_record);
      }

      const hwaccel = video_record.permitHWDecode ? 'auto' : 'none';
      const source_video_codec = ffprobe_data.streams.find((s) => s.codec_type === 'video')?.codec_name;
      const source_audio_codec = ffprobe_data.streams.find((s) => s.codec_type === 'audio')?.codec_name;
      const { audio_language } = video_record;

      // Build FFmpeg input stream mappings
      const input_maps = [`-map 0:${transcode_instructions.video.stream_index}`]
        .concat(transcode_instructions.audio.map((audio) => `-map 0:${audio.stream_index}`))
        .concat(transcode_instructions.subtitles.map((subtitle) => `-map 0:${subtitle.stream_index}`));

      if (ffprobe_data.chapters.length > 0) {
        input_maps.push(`-map_chapters 0`);
      }

      const mainVideoStream = ffprobe_data.streams.find((s) => s.codec_type === 'video');
      let totalFrames = parseInt(mainVideoStream.nb_frames || 0, 10);

      if (Number.isNaN(totalFrames) || totalFrames <= 0) {
        totalFrames = 0;
      }

      let cmd = ffmpeg(file).inputOptions(['-v fatal', '-stats', `-hwaccel ${hwaccel}`].filter(Boolean))
        .outputOptions(input_maps)
        .outputOptions([
          `-c:v ${transcode_instructions.video.codec}`,
          ...Object.entries(transcode_instructions.video.arguments || {}).map(([k, v]) => `-${k} ${v}`)
        ])
        .outputOptions(transcode_instructions.audio
          .flatMap((audio, idx) => [`-c:a:${idx} ${audio.codec}`, audio.bitrate && `-b:a:${idx} ${audio.bitrate}`, `-map_metadata:s:a:${idx} 0:s:a:${idx}`].filter(Boolean)))
        .outputOptions(transcode_instructions.subtitles
          .flatMap((subtitle, idx) => [`-c:s:${idx} ${subtitle.codec}`, `-map_metadata:s:s:${idx} 0:s:s:${idx}`]))
        .outputOptions(`-metadata encode_version=${encode_version}`);

      let ffmpeg_cmd;
      let start_time;
      const original_size = (await stat(file)).size;
      const startTime = Date.now();
      let lastLogTime = startTime;

      cmd = cmd
        .on('start', async (commandLine) => {
          logger.info(`Spawned Ffmpeg with command: ${commandLine}`);
          start_time = dayjs();
          ffmpeg_cmd = commandLine;
          generate_filelist({ limit: 1000, writeToFile: true });

          video_record.error = undefined;
          video_record.transcode_details = {
            start_time: start_time.toDate(),
            source_codec: `${source_video_codec}_${source_audio_codec}`
          };
          await video_record.saveDebounce();
        })
        .on('progress', (progress) => {
          const now = Date.now();

          if (now - lastLogTime < LOG_THROTTLE_MS) return;
          lastLogTime = now;

          const elapsed = dayjs().diff(start_time, 'seconds');
          const currentFrames = progress.frames || 0;
          const percent = totalFrames > 0 ? (currentFrames / totalFrames) * 100 : progress.percent;
          const pct_per_second = percent / elapsed;
          const seconds_pct = pct_per_second > 0 ? 1 / pct_per_second : Infinity;
          const pct_remaining = 100 - percent;
          const est_completed_seconds = pct_remaining * seconds_pct;
          const est_completed_timestamp = Date.now() + (est_completed_seconds * 1000);
          const time_remaining = formatSecondsToHHMMSS(est_completed_seconds);
          const estimated_final_kb = (progress.targetSize / percent) * 100;

          const output = JSON.stringify({
            ...progress,
            startTime,
            refreshed: Date.now(),
            percent,
            source_audio_codec,
            source_video_codec,
            audio_language,
            run_time: dayjs.utc(elapsed * 1000).format('HH:mm:ss'),
            pct_per_second,
            pct_remaining,
            time_remaining,
            est_completed_seconds,
            est_completed_timestamp,
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
                change: `${((estimated_final_kb - ffprobe_data.format.size) / ffprobe_data.format.size) * 100}%`
              },
              original: {
                kb: ffprobe_data.format.size,
                mb: ffprobe_data.format.size / 1024,
                gb: ffprobe_data.format.size / 1024 / 1024
              }
            },
            action: 'transcode'
          }, null, 4);

          fs.writeFileSync(`/usr/app/output/active-${video_record._id}.json`, JSON.stringify({ ffmpeg_cmd, audio_language, file, ...(JSON.parse(output)) }));
        })
        .on('end', async () => {
          try {
            logger.info('Transcoding succeeded!');
            await wait(5);
            if (!fs.existsSync(scratch_file)) {
              throw new Error(`Scratch file ${scratch_file} not found after transcode complete.`);
            }

            await moveFile(scratch_file, dest_file);
            await fs.promises.utimes(dest_file, new Date(), new Date());
            global.processed_files_delta += 1;
            const dest_file_size = (await stat(dest_file)).size;

            if (dest_file !== file) {
              await trash(file, false);
            }

            await probe_and_upsert(dest_file, video_record._id, {
              transcode_details: {
                ...video_record.transcode_details,
                end_time: dayjs().toDate(),
                duration: dayjs().diff(start_time, 'seconds')
              },
              reclaimedSpace: original_size - dest_file_size
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
          fs.appendFileSync('/usr/app/logs/ffmpeg.log', JSON.stringify({ error: err.message, stdout, stderr, ffmpeg_cmd, trace: err.stack }, null, 4));
          await trash(scratch_file, false);

          // FFmpeg error 251 typically means a hardware decoder failed to initialize (e.g., unsupported GPU or corrupted driver).
          // Disabling hardware decode ensures fallback to software on retry.
          if (/251/i.test(err.message)) {
            logger.warn('FFmpeg error 251 detected. Disabling hardware acceleration for this video.');
            video_record.permitHWDecode = false;
          }

          Object.assign(video_record, {
            error: { error: err.message, stdout, stderr, ffmpeg_cmd, trace: err.stack },
            hasError: true
          });
          await video_record.saveDebounce();

          await ErrorLog.create({
            path: file,
            error: { error: err.message, stdout, stderr, ffmpeg_cmd, trace: err.stack }
          });

          resolve({});
        });

      cmd.save(scratch_file);
    } catch (e) {
      logger.error(e, { label: 'TRANSCODE ERROR' });
      await upsert_video({ path: file, error: { error: e.message, trace: e.stack }, hasError: true });
      await ErrorLog.create({ path: file, error: { error: e.message, trace: e.stack } });

      if (/no\s+(video|audio)\s+stream\s+found/gi.test(e.message)) await trash(file);
      if (/file\s+not\s+found/gi.test(e.message)) await trash(file);

      resolve({});
    }
  });
}
