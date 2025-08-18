
/**
 * @module Transcode
 * @description
 * Hardware-accelerated, metadata-preserving video transcoding using FFmpeg.
 * - Dynamically generates transcode instructions based on source video metadata
 * - Tracks progress frame-accurately and streams status/metrics for real-time monitoring
 * - Handles file staging, sanitation, integrity checks, and error logging
 *
 * Developed by TC, with enhancements assisted by ChatGPT from OpenAI.
 *
 * @see generateTranscodeInstructions
 * @see ffprobe
 * @see moveFile
 * @see update_status
 * @see probe_and_upsert
 */

import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import dayjs from 'dayjs';
import { stat } from 'fs/promises';
import ffprobe from './ffprobe';
import config from './config';
import logger from './logger';
import { trash, generate_file_paths } from './fs';
import exec_promise from './exec_promise';
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

/**
 * Converts seconds into a zero-padded HH:mm:ss string.
 * Used for ETA and progress reporting.
 *
 * @param {number} totalSeconds - Number of seconds to format
 * @returns {string} Formatted time string (HH:mm:ss)
 */
export function formatSecondsToHHMMSS (totalSeconds) {
  if (Number.isNaN(totalSeconds)) return 'calculating';

  const total = Math.ceil(Number(totalSeconds)); // round up for display
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Transcodes a video file using hardware acceleration and dynamic instructions.
 * Handles file staging, integrity checks, progress reporting, and error logging.
 *
 * @param {Object} file - MongoDB File record or file path object
 * @returns {Promise<Object>} Resolves when transcode completes or fails
 */
export default function transcode (file) {
  return new Promise(async (resolve) => {
    try {
      // Accepts either a MongoDB File record or a file path object
      const video_record = file;
      file = file.path;
      // Validate input and presence of Mongo record
      if (!video_record || !video_record?._id) {
        throw new Error(`Video record not found for file: ${file}`);
      }

      // Ensure file exists before proceeding
      if (!fs.existsSync(file)) {
        throw new Error(`File not found: ${file}`);
      }

      // Probe the input video and attach metadata to record
      let ffprobe_data = video_record.probe;

      // If probe data is missing, run ffprobe and save results
      if (!ffprobe_data) {
        ffprobe_data = await ffprobe(file);
        video_record.probe = ffprobe_data;
        await video_record.saveDebounce();
      }

      // Generate transcode instructions based on video metadata
      const transcode_instructions = generateTranscodeInstructions(video_record);
      logger.debug(transcode_instructions, { label: 'Transcode Instructions' });

      if (!transcode_instructions.video) {
        throw new Error('No video stream found');
      }

      // Generate file paths for scratch, destination, and staging
      const { scratch_file, dest_file, stage_file } = generate_file_paths(file);

      /**
       * If stage_file is set, copy the source file to stage_file and use stage_file for transcoding.
       * Progress is reported every second to transcodeQueue.runningJobs for real-time monitoring.
       */
      if (stage_file) {
        try {
          const totalSize = (await stat(file)).size;
          let skipCopy = false;
          // If stage_file already exists and matches source size, skip copy
          if (fs.existsSync(stage_file)) {
            const stageStats = await stat(stage_file);
            if (stageStats.size === totalSize) {
              logger.info(`Stage file already exists and matches source size (${totalSize} bytes). Skipping copy.`);
              skipCopy = true;
            } else {
              logger.info(`Stage file exists but size mismatch (source: ${totalSize}, stage: ${stageStats.size}). Re-copying.`);
            }
          }
          if (!skipCopy) {
            logger.info(`Copying source file to stage_file: ${stage_file}`);
            const startTime = Date.now();
            let lastPercent = 0;
            let interval;
            // Start interval to report copy progress every second
            if (totalSize > 0) {
              interval = setInterval(() => {
                try {
                  if (fs.existsSync(stage_file)) {
                    const stageStats = fs.statSync(stage_file);
                    const copied = stageStats.size;
                    const percent = Math.min(((copied / totalSize) * 100), 100).toFixed(2);
                    const elapsed = (Date.now() - startTime) / 1000;
                    const pct_per_second = percent / elapsed;
                    const seconds_pct = pct_per_second > 0 ? 1 / pct_per_second : Infinity;
                    const pct_remaining = 100 - percent;
                    const est_completed_seconds = pct_remaining * seconds_pct;
                    const est_completed_timestamp = Date.now() + (est_completed_seconds * 1000);
                    const time_remaining = formatSecondsToHHMMSS(est_completed_seconds);
                    // Calculate currentKbps (kilobits per second), rounded
                    const currentKbps = elapsed > 0 ? Math.round(((copied * 8) / 1024) / elapsed) : 0;
                    // Log progress only if percent changed
                    if (percent !== lastPercent) {
                      logger.info(`${stage_file} copy progress: ${percent}% (${copied}/${totalSize} bytes, ${currentKbps} kbps)`);
                      lastPercent = percent;
                    }
                    // Update running job status for UI/monitoring
                    if (global.transcodeQueue && video_record && video_record._id) {
                      const runningJobIndex = global.transcodeQueue.runningJobs.findIndex((j) => j._id.toString() === video_record._id.toString());
                      if (runningJobIndex !== -1) {
                        Object.assign(global.transcodeQueue.runningJobs[runningJobIndex], {
                          percent,
                          est_completed_timestamp,
                          time_remaining,
                          action: 'staging',
                          currentKbps,
                          startTime
                        });
                      }
                    }
                  }
                } catch (e) {
                  // Ignore stat errors during copy
                  logger.error(e, { label: 'Stage file copy progress error' });
                }
              }, 1000);
            }
            // Use OS-level cp for fast copy
            await exec_promise(`cp "${file}" "${stage_file}"`);
            if (interval) clearInterval(interval);
            // After copy, report 100% progress
            const percent = 100;
            const time_remaining = formatSecondsToHHMMSS(0);
            const est_completed_timestamp = Date.now();
            const currentKbps = Math.round(((totalSize * 8) / 1024) / ((est_completed_timestamp - startTime) / 1000));
            logger.info(`${stage_file} copy complete: 100% (${totalSize}/${totalSize} bytes, ${currentKbps} kbps)`);
            if (global.transcodeQueue && video_record && video_record._id) {
              const runningJobIndex = global.transcodeQueue.runningJobs.findIndex((j) => j._id.toString() === video_record._id.toString());
              if (runningJobIndex !== -1) {
                Object.assign(global.transcodeQueue.runningJobs[runningJobIndex], {
                  percent,
                  est_completed_timestamp,
                  time_remaining,
                  action: 'staging',
                  currentKbps,
                  startTime
                });
              }
            }
          }
          // Use stage_file for transcoding
          file = stage_file;
        } catch (copyErr) {
          logger.error(copyErr, { label: 'STAGE FILE COPY ERROR', file, stage_file });
          throw new Error(`Failed to copy source file to stage_file: ${copyErr.message}`);
        }
      }

      // Short-circuit if this encode version already exists (prevents double-encoding)
      if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
        logger.debug({ file, encode_version }, { label: 'File already encoded' });
        video_record.encode_version = ffprobe_data.format.tags?.ENCODE_VERSION;
        await video_record.saveDebounce();
        return resolve({ locked: true });
      }

      // Check file integrity if not previously validated
      if (!video_record.integrityCheck) {
        logger.debug("File hasn't been integrity checked. Checking before transcode");
        await integrityCheck(video_record);
      }

      // Hardware acceleration and codec info
      const hwaccel = video_record.permitHWDecode ? 'auto' : 'none';
      const source_video_codec = ffprobe_data.streams.find((s) => s.codec_type === 'video')?.codec_name;
      const source_audio_codec = ffprobe_data.streams.find((s) => s.codec_type === 'audio')?.codec_name;
      const { audio_language } = video_record;

      // Build FFmpeg input stream mappings for video, audio, subtitles, chapters
      const input_maps = [`-map_metadata 0`, `-map 0:${transcode_instructions.video.stream_index}`]
        .concat(transcode_instructions.audio.map((audio) => `-map 0:${audio.stream_index}`))
        .concat(transcode_instructions.subtitles.map((subtitle) => `-map 0:${subtitle.stream_index}`));

      if (ffprobe_data.chapters.length > 0) {
        input_maps.push(`-map_chapters 0`);
      }

      // Total frame count for progress tracking
      const mainVideoStream = ffprobe_data.streams.find((s) => s.codec_type === 'video');
      let totalFrames = parseInt(mainVideoStream.nb_frames || 0, 10);
      if (Number.isNaN(totalFrames) || totalFrames <= 0) {
        totalFrames = 0;
      }

      // Build FFmpeg command with all input/output options
      let cmd = ffmpeg(file)
        .inputOptions(['-v fatal', '-stats', `-hwaccel ${hwaccel}`].filter(Boolean))
        .outputOptions(input_maps)
        .outputOptions([
          `-c:v ${transcode_instructions.video.codec}`,
          ...Object.entries(transcode_instructions.video.arguments || {}).map(([k, v]) => `-${k} ${v}`)
        ])
        .outputOptions(transcode_instructions.audio
          .flatMap((audio, idx) => [
            `-c:a:${idx} ${audio.codec}`,
            audio.bitrate && `-b:a:${idx} ${audio.bitrate}`,
            audio.channels && `-ac:${idx} ${audio.channels}`,
            audio.channel_layout && `-filter:a:${idx} channelmap=channel_layout=${audio.channel_layout}`,
            `-map_metadata:s:a:${idx} 0:s:a:${idx}`
          ].filter(Boolean)))
        .outputOptions(transcode_instructions.subtitles
          .flatMap((subtitle, idx) => [
            `-c:s:${idx} ${subtitle.codec}`,
            `-map_metadata:s:s:${idx} 0:s:s:${idx}`
          ]))
        .outputOptions(`-metadata encode_version=${encode_version}`);

      // Track ffmpeg command, start time, and original file size for reporting
      let ffmpeg_cmd;
      let start_time;
      const original_size = (await stat(file)).size;
      const startTime = Date.now();

      // FFmpeg event handlers: start, progress, end, error
      cmd = cmd
        .on('start', async (commandLine) => {
          // FFmpeg process started
          logger.info(`Spawned Ffmpeg with command: ${commandLine}`);
          start_time = dayjs();
          ffmpeg_cmd = commandLine;
          generate_filelist({ limit: 1000, writeToFile: true });

          // Clear previous error and set transcode details
          video_record.error = undefined;
          video_record.transcode_details = {
            start_time: start_time.toDate(),
            source_codec: `${source_video_codec}_${source_audio_codec}`
          };
          await video_record.saveDebounce();
          // Set action to 'transcoding' at start for UI/monitoring
          if (global.transcodeQueue && video_record && video_record._id) {
            const runningJobIndex = global.transcodeQueue.runningJobs.findIndex((j) => j._id.toString() === video_record._id.toString());
            if (runningJobIndex !== -1) {
              Object.assign(global.transcodeQueue.runningJobs[runningJobIndex], {
                action: 'transcoding',
                percent: 0,
                eta: null,
                time_remaining: null
              });
            }
          }
        })
        .on('progress', (progress) => {
          // FFmpeg progress event: update percent, ETA, and metrics
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

          // Build output object for UI/monitoring
          const output = {
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
            indexerData: video_record.indexerData || {},
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
            action: 'transcoding'
          };

          // Find the job in the transcodeQueue and update its status
          const runningJobIndex = global.transcodeQueue.runningJobs.findIndex((j) => j._id.toString() === video_record._id.toString());
          Object.assign(global.transcodeQueue.runningJobs[runningJobIndex], { ffmpeg_cmd, audio_language, file, ...output });
        })
        .on('end', async () => {
          // FFmpeg end event: finalize output, cleanup, update status
          try {
            await wait(5);

            // Ensure scratch file exists before moving
            if (!fs.existsSync(scratch_file)) {
              throw new Error(`Scratch file ${scratch_file} not found after transcode complete.`);
            }

            // Finalizing step: move scratch_file to dest_file
            // Track progress of scratch_file -> dest_file move
            const moveStartTime = Date.now();
            let moveInterval;
            const scratchSize = (await stat(scratch_file)).size;
            if (scratchSize > 0) {
              moveInterval = setInterval(() => {
                try {
                  if (fs.existsSync(dest_file)) {
                    const destStats = fs.statSync(dest_file);
                    const copied = destStats.size;
                    const percent = Math.min(((copied / scratchSize) * 100), 100).toFixed(2);
                    const elapsed = (Date.now() - moveStartTime) / 1000;
                    const pct_per_second = percent / elapsed;
                    const seconds_pct = pct_per_second > 0 ? 1 / pct_per_second : Infinity;
                    const pct_remaining = 100 - percent;
                    const est_completed_seconds = pct_remaining * seconds_pct;
                    const est_completed_timestamp = Date.now() + (est_completed_seconds * 1000);
                    const time_remaining = formatSecondsToHHMMSS(est_completed_seconds);
                    // Calculate currentKbps (kilobits per second), rounded
                    const currentKbps = elapsed > 0 ? Math.round(((copied * 8) / 1024) / elapsed) : 0;
                    // Log progress only if percent changed
                    logger.info(`${dest_file} move progress: ${percent}% (${copied}/${scratchSize} bytes, ${currentKbps} kbps)`);
                    // Update running job status for UI/monitoring
                    if (global.transcodeQueue && video_record && video_record._id) {
                      const runningJobIndex = global.transcodeQueue.runningJobs.findIndex((j) => j._id.toString() === video_record._id.toString());
                      if (runningJobIndex !== -1) {
                        Object.assign(global.transcodeQueue.runningJobs[runningJobIndex], {
                          percent,
                          est_completed_timestamp,
                          time_remaining,
                          action: 'finalizing',
                          currentKbps,
                          moveStartTime
                        });
                      }
                    }
                  }
                } catch (e) {
                  logger.error(e, { label: 'Dest file move progress error' });
                }
              }, 1000);
            }
            await moveFile(scratch_file, dest_file);
            if (moveInterval) clearInterval(moveInterval);
            // After move, report 100% progress
            const percent = 100;
            const time_remaining = formatSecondsToHHMMSS(0);
            const est_completed_timestamp = Date.now();
            const currentKbps = Math.round(((scratchSize * 8) / 1024) / ((est_completed_timestamp - moveStartTime) / 1000));
            logger.info(`${dest_file} move complete: 100% (${scratchSize}/${scratchSize} bytes, ${currentKbps} kbps)`);
            if (global.transcodeQueue && video_record && video_record._id) {
              const runningJobIndex = global.transcodeQueue.runningJobs.findIndex((j) => j._id.toString() === video_record._id.toString());
              if (runningJobIndex !== -1) {
                Object.assign(global.transcodeQueue.runningJobs[runningJobIndex], {
                  percent,
                  est_completed_timestamp,
                  time_remaining,
                  action: 'finalizing',
                  currentKbps,
                  moveStartTime
                });
              }
            }

            // Delete stage_file if it exists
            if (stage_file && fs.existsSync(stage_file)) {
              try {
                await fs.promises.unlink(stage_file);
                logger.info(`Deleted stage_file after transcode: ${stage_file}`);
              } catch (stageDelErr) {
                logger.warn(`Failed to delete stage_file: ${stage_file}`, stageDelErr);
              }
            }

            // Update file times and processed count
            await fs.promises.utimes(dest_file, new Date(), new Date());
            global.processed_files_delta += 1;

            // Calculate reclaimed space and update Mongo record
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
          // FFmpeg error event: log, cleanup, update error status
          logger.error(err, { label: 'Cannot process video', stdout, stderr });
          fs.appendFileSync('/usr/app/logs/ffmpeg.log', JSON.stringify({ error: err.message, stdout, stderr, ffmpeg_cmd, trace: err.stack }, null, 4));

          await trash(scratch_file, false);
          // Delete stage_file if it exists
          if (stage_file && fs.existsSync(stage_file)) {
            try {
              await fs.promises.unlink(stage_file);
              logger.info(`Deleted stage_file after error: ${stage_file}`);
            } catch (stageDelErr) {
              logger.warn(`Failed to delete stage_file: ${stage_file}`, stageDelErr);
            }
          }

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

      // Start FFmpeg transcoding to scratch_file
      cmd.save(scratch_file);
    } catch (e) {
      // Top-level error: log, update Mongo record, cleanup
      logger.error(e, { label: 'TRANSCODE ERROR' });
      await upsert_video({ path: file, error: { error: e.message, trace: e.stack }, hasError: true });
      await ErrorLog.create({ path: file, error: { error: e.message, trace: e.stack } });

      // Trash file if no video/audio stream or file not found
      if (/no\s+(video|audio)\s+stream\s+found/gi.test(e.message)) await trash(file);
      if (/file\s+not\s+found/gi.test(e.message)) await trash(file);

      resolve({});
    }
  });
}
