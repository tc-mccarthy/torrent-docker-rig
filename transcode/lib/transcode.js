/**
 * @module Transcode
 * @description
 * Hardware-accelerated, metadata-preserving video transcoding using FFmpeg.
 *
 * This module used to rely on the `fluent-ffmpeg` wrapper. Since fluent-ffmpeg is no
 * longer maintained, we now spawn `ffmpeg` directly via Node's `child_process.spawn`.
 *
 * Key goals of this refactor:
 * - Preserve all existing functionality (stream mapping, metadata preservation, staging,
 *   integrity checks, and post-transcode bookkeeping).
 * - Preserve progress monitoring (frame-accurate when possible) without unbounded memory
 *   growth. We use `-progress pipe:1` and a bounded stderr ring buffer.
 * - Keep memory headroom predictable under long-running workloads (no stdout/stderr
 *   buffering of entire sessions).
 *
 * Developed by TC, with enhancements assisted by ChatGPT from OpenAI.
 */

import fs from 'fs';
import dayjs from 'dayjs';
import readline from 'readline';
import { spawn } from 'child_process';
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
 * A tiny ring buffer for log lines.
 * Keeps the last `maxLines` lines to avoid unbounded memory growth when ffmpeg is chatty.
 *
 * @param {number} maxLines - Maximum number of lines to retain.
 */
class LineRingBuffer {
  constructor (maxLines) {
    this.maxLines = Math.max(50, Number(maxLines) || 500);
    this.lines = [];
  }

  push (line) {
    if (!line) return;
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  toString () {
    return this.lines.join('\n');
  }
}

/**
 * Build the ffmpeg CLI argument list matching the prior fluent-ffmpeg configuration.
 *
 * Notes:
 * - We prefer `-progress pipe:1` for structured progress events.
 * - We keep `-v fatal` (as before) to avoid verbose stderr. We also set `-nostats`
 *   to reduce the default stat line spam; progress is obtained via `-progress`.
 *
 * @param {Object} params
 * @param {string} params.inputFile
 * @param {string} params.outputFile
 * @param {Object} params.ffprobeData
 * @param {Object} params.instructions - Result of generateTranscodeInstructions(video_record)
 * @param {string} params.hwaccel - 'auto' or 'none'
 * @returns {{ args: string[], inputMaps: string[] }}
 */
function buildFfmpegArgs ({
  inputFile,
  outputFile,
  ffprobeData,
  instructions,
  hwaccel
}) {
  // Stream mappings: metadata + chapters + video/audio/subtitle streams
  const inputMaps = [
    '-map_metadata',
    '0',
    '-map',
    `0:${instructions.video.stream_index}`
  ];

  instructions.audio.forEach((audio) => {
    inputMaps.push('-map', `0:${audio.stream_index}`);
  });

  instructions.subtitles.forEach((subtitle) => {
    inputMaps.push('-map', `0:${subtitle.stream_index}`);
  });

  if ((ffprobeData.chapters || []).length > 0) {
    inputMaps.push('-map_chapters', '0');
  }

  // Output options
  const out = [];

  // Video codec + arguments
  out.push('-c:v', String(instructions.video.codec));
  Object.entries(instructions.video.arguments || {}).forEach(([k, v]) => {
    // instruction args were previously expressed as `-key value` pairs in fluent-ffmpeg.
    out.push(`-${k}`, String(v));
  });

  // Audio streams: preserve stream-level metadata, filters, channels, bitrate
  instructions.audio.forEach((audio, idx) => {
    out.push(`-c:a:${idx}`, String(audio.codec));
    if (audio.bitrate) out.push(`-b:a:${idx}`, String(audio.bitrate));
    if (audio.channels) out.push(`-ac:${idx}`, String(audio.channels));
    if (audio.filter) out.push(`-filter:a:${idx}`, String(audio.filter));
    out.push(`-map_metadata:s:a:${idx}`, `0:s:a:${idx}`);
  });

  // Subtitle streams: preserve stream-level metadata
  instructions.subtitles.forEach((subtitle, idx) => {
    out.push(`-c:s:${idx}`, String(subtitle.codec));
    out.push(`-map_metadata:s:s:${idx}`, `0:s:s:${idx}`);
  });

  // Encode version tag (prior behavior)
  out.push('-metadata', `encode_version=${encode_version}`);

  // Assemble final args:
  // - `-progress pipe:1` writes key=value progress to stdout.
  // - `-nostats` suppresses the default progress line spam on stderr.
  // - `-hwaccel auto|none` preserves your runtime behavior.
  const args = [
    '-v',
    'fatal',
    '-nostats',
    '-progress',
    'pipe:1',
    '-stats_period',
    '1',
    '-hwaccel',
    hwaccel,
    '-i',
    inputFile,
    ...inputMaps,
    ...out,
    outputFile
  ];

  return { args, inputMaps };
}

/**
 * Extracts a best-effort total frame count from ffprobe, used for percent calculations.
 * Some containers do not include nb_frames; in that case we fall back to 0 and use time-based
 * progress if available.
 *
 * @param {Object} ffprobeData
 * @returns {{ totalFrames: number, fps: number|null, durationSeconds: number|null }}
 */
function getProgressReference (ffprobeData) {
  const mainVideoStream = (ffprobeData.streams || []).find(
    (s) => s.codec_type === 'video'
  );
  const nbFrames = parseInt(mainVideoStream?.nb_frames || 0, 10);
  const totalFrames = Number.isFinite(nbFrames) && nbFrames > 0 ? nbFrames : 0;

  // Try to infer fps (may be "24000/1001")
  let fps = null;
  const rate = mainVideoStream?.avg_frame_rate || mainVideoStream?.r_frame_rate;
  if (rate && typeof rate === 'string' && rate.includes('/')) {
    const [a, b] = rate.split('/').map((x) => Number(x));
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) fps = a / b;
  } else if (Number.isFinite(Number(rate))) {
    fps = Number(rate);
  }

  const durationSeconds = Number.isFinite(Number(ffprobeData.format?.duration))
    ? Number(ffprobeData.format.duration)
    : null;

  return { totalFrames, fps, durationSeconds };
}

/**
 * Updates the in-memory runningJobs entry with new fields, if it exists.
 * Keeps this helper small so we don't accidentally retain huge objects.
 *
 * @param {string} recordId
 * @param {Object} patch
 */
function patchRunningJob (recordId, patch) {
  if (!global.transcodeQueue || !recordId) return;
  const idx = global.transcodeQueue.runningJobs.findIndex(
    (j) => String(j._id) === String(recordId)
  );
  if (idx === -1) return;
  Object.assign(global.transcodeQueue.runningJobs[idx], patch);
}

/**
 * Transcodes a video file using hardware acceleration and dynamic instructions.
 * Handles file staging, integrity checks, progress reporting, and error logging.
 *
 * @param {Object} file - MongoDB File record
 * @returns {Promise<Object>} Resolves when transcode completes or fails
 */
export default function transcode (file) {
  return new Promise(async (resolve) => {
    let child = null;

    try {
      // Accepts a MongoDB File record (caller should pass the record, not just a path)
      const video_record = file;
      let inputFile = file.path;
      const original_file = inputFile;

      // Validate input and presence of Mongo record
      if (!video_record || !video_record?._id) {
        throw new Error(`Video record not found for file: ${inputFile}`);
      }

      // Ensure file exists before proceeding
      if (!fs.existsSync(inputFile)) {
        throw new Error(`File not found: ${inputFile}`);
      }

      // Probe the input video and attach metadata to record
      let ffprobe_data = video_record.probe;

      // If probe data is missing, run ffprobe and save results
      if (!ffprobe_data) {
        ffprobe_data = await ffprobe(inputFile);
        video_record.probe = ffprobe_data;
        await video_record.saveDebounce();
      }

      // Generate transcode instructions based on video metadata
      const transcode_instructions =
        generateTranscodeInstructions(video_record);
      logger.debug(transcode_instructions, { label: 'Transcode Instructions' });

      if (!transcode_instructions.video) {
        throw new Error('No video stream found');
      }

      // Generate file paths for scratch, destination, and staging
      const { scratch_file, dest_file, stage_file } =
        generate_file_paths(inputFile);

      /**
       * If stage_file is set, copy the source file to stage_file and use stage_file for transcoding.
       * Progress is reported every second to transcodeQueue.runningJobs for real-time monitoring.
       */
      if (stage_file) {
        try {
          const totalSize = (await stat(inputFile)).size;
          let skipCopy = false;

          // If stage_file already exists and matches source size, skip copy
          if (fs.existsSync(stage_file)) {
            const stageStats = await stat(stage_file);
            if (stageStats.size === totalSize) {
              logger.debug(
                `Stage file already exists and matches source size (${totalSize} bytes). Skipping copy.`
              );
              skipCopy = true;
            } else {
              logger.debug(
                `Stage file exists but size mismatch (source: ${totalSize}, stage: ${stageStats.size}). Re-copying.`
              );
            }
          }

          if (!skipCopy) {
            logger.debug(`Copying source file to stage_file: ${stage_file}`);
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
                    const percent = Math.min(
                      (copied / totalSize) * 100,
                      100
                    ).toFixed(2);
                    const elapsed = (Date.now() - startTime) / 1000;
                    const pct_per_second = Number(percent) / elapsed;
                    const seconds_pct =
                      pct_per_second > 0 ? 1 / pct_per_second : Infinity;
                    const pct_remaining = 100 - Number(percent);
                    const est_completed_seconds = pct_remaining * seconds_pct;
                    const est_completed_timestamp =
                      Date.now() + est_completed_seconds * 1000;
                    const time_remaining = formatSecondsToHHMMSS(
                      est_completed_seconds
                    );

                    // Calculate currentKbps (kilobits per second), rounded
                    const currentKbps =
                      elapsed > 0
                        ? Math.round((copied * 8) / 1024 / elapsed)
                        : 0;

                    // Log progress only if percent changed
                    if (percent !== lastPercent) {
                      logger.debug(
                        `${stage_file} copy progress: ${percent}% (${copied}/${totalSize} bytes, ${currentKbps} kbps)`
                      );
                      lastPercent = percent;
                    }

                    // Update running job status for UI/monitoring
                    patchRunningJob(video_record._id, {
                      percent,
                      est_completed_timestamp,
                      time_remaining,
                      action: 'staging',
                      currentKbps,
                      startTime
                    });
                  }
                } catch (e) {
                  // Ignore stat errors during copy
                  logger.error(e, { label: 'Stage file copy progress error' });
                }
              }, 1000);
            }

            // Use OS-level cp for fast copy
            await exec_promise(
              `cp --reflink=never --sparse=never --preserve=timestamps "${inputFile}" "${stage_file}"`
            );
            if (interval) clearInterval(interval);

            // After copy, report 100% progress
            const percent = 100;
            const time_remaining = formatSecondsToHHMMSS(0);
            const est_completed_timestamp = Date.now();
            const elapsed = (est_completed_timestamp - startTime) / 1000;
            const currentKbps =
              elapsed > 0 ? Math.round((totalSize * 8) / 1024 / elapsed) : 0;

            logger.debug(
              `${stage_file} copy complete: 100% (${totalSize}/${totalSize} bytes, ${currentKbps} kbps)`
            );
            patchRunningJob(video_record._id, {
              percent,
              est_completed_timestamp,
              time_remaining,
              action: 'staging',
              currentKbps,
              startTime
            });
          }

          // Use stage_file for transcoding
          inputFile = stage_file;
        } catch (copyErr) {
          logger.error(copyErr, {
            label: 'STAGE FILE COPY ERROR',
            inputFile,
            stage_file
          });
          throw new Error(
            `Failed to copy source file to stage_file: ${copyErr.message}`
          );
        }
      }

      // Short-circuit if this encode version already exists (prevents double-encoding)
      if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
        logger.debug(
          { file: inputFile, encode_version },
          { label: 'File already encoded' }
        );
        video_record.encode_version = ffprobe_data.format.tags?.ENCODE_VERSION;
        await video_record.saveDebounce();
        return resolve({ locked: true });
      }

      // Check file integrity if not previously validated
      if (!video_record.integrityCheck) {
        logger.debug(
          "File hasn't been integrity checked. Checking before transcode"
        );
        await integrityCheck(video_record);
      }

      // Hardware acceleration and codec info
      const hwaccel = video_record.permitHWDecode ? 'auto' : 'none';
      const source_video_codec = (ffprobe_data.streams || []).find(
        (s) => s.codec_type === 'video'
      )?.codec_name;
      const source_audio_codec = (ffprobe_data.streams || []).find(
        (s) => s.codec_type === 'audio'
      )?.codec_name;
      const { audio_language } = video_record;

      const { totalFrames, durationSeconds } =
        getProgressReference(ffprobe_data);

      // Track ffmpeg command, start time, and original file size for reporting
      let ffmpeg_cmd = null;
      let start_time = null;
      const original_size = (await stat(inputFile)).size;
      const startTime = Date.now();

      // Build ffmpeg args
      const { args } = buildFfmpegArgs({
        inputFile,
        outputFile: scratch_file,
        ffprobeData: ffprobe_data,
        instructions: transcode_instructions,
        hwaccel
      });

      // For debugging / UI: store a shell-escaped-ish command line string.
      ffmpeg_cmd = `ffmpeg ${args
        .map((a) => (a.includes(' ') ? `"${a}"` : a))
        .join(' ')}`;

      // Log the ffmpeg command when transcoding starts
      logger.info({ ffmpeg_cmd }, { label: 'Starting transcode with command' });

      // Kick UI job state at start
      patchRunningJob(video_record._id, {
        action: 'transcoding',
        percent: 0,
        eta: null,
        time_remaining: null,
        ffmpeg_cmd,
        file: inputFile
      });

      // Persist start details (same behavior as before)
      start_time = dayjs();
      generate_filelist({ limit: 1000, writeToFile: true });

      video_record.error = undefined;
      video_record.transcode_details = {
        start_time: start_time.toDate(),
        source_codec: `${source_video_codec}_${source_audio_codec}`
      };
      await video_record.saveDebounce();

      /**
       * Progress parsing:
       * We use `-progress pipe:1` which emits blocks like:
       *   frame=123
       *   fps=...
       *   out_time_ms=...
       *   total_size=...
       *   speed=...
       *   progress=continue
       * or `progress=end` at completion.
       *
       * We update UI state on each block boundary (`progress=`).
       */
      const stderrRing = new LineRingBuffer(500);
      let lastTimemark = null;

      // Spawn ffmpeg
      child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      // Track PID in job state
      patchRunningJob(video_record._id, { pid: child.pid });

      // Parse progress from stdout
      const rlOut = readline.createInterface({ input: child.stdout });
      let progressBlock = {};

      const flushProgressBlock = () => {
        // Only flush if this looks like a real block
        if (!progressBlock || Object.keys(progressBlock).length === 0) return;

        const now = Date.now();
        const elapsed = dayjs().diff(start_time, 'seconds');

        const frame = Number(progressBlock.frame || 0);
        const totalSizeBytes = Number(progressBlock.total_size || 0);

        // out_time_ms is more reliable than timemark strings
        const outTimeMs = Number(progressBlock.out_time_ms || 0);
        const outSeconds = outTimeMs > 0 ? outTimeMs / 1_000_000 : null;

        // Derive percent:
        // 1) Prefer frame-based percent when totalFrames is known.
        // 2) Else fall back to time-based percent when duration is known.
        let percent = 0;
        if (totalFrames > 0 && frame > 0) {
          percent = (frame / totalFrames) * 100;
        } else if (durationSeconds && outSeconds != null) {
          percent = (outSeconds / durationSeconds) * 100;
        }

        // Clamp percent to [0, 100]
        percent = Math.max(0, Math.min(100, percent));

        // ETA estimate
        const pct_per_second = elapsed > 0 ? percent / elapsed : 0;
        const seconds_pct = pct_per_second > 0 ? 1 / pct_per_second : Infinity;
        const pct_remaining = 100 - percent;
        const est_completed_seconds = pct_remaining * seconds_pct;
        const est_completed_timestamp = now + est_completed_seconds * 1000;
        const time_remaining = formatSecondsToHHMMSS(est_completed_seconds);
        const original_file_size_bytes = (ffprobe_data.format.size || 0) * 1024;

        // Build a timemark (HH:mm:ss.xx) for deduping UI updates.
        // If out_time is present, keep it; otherwise synthesize from outSeconds.
        let timemark;
        if (progressBlock.out_time) {
          timemark = String(progressBlock.out_time);
        } else if (outSeconds != null) {
          timemark = dayjs.utc(outSeconds * 1000).format('HH:mm:ss.SS');
        } else {
          timemark = null;
        }

        // Estimated final size (best effort)
        const targetSizeKB = totalSizeBytes > 0 ? totalSizeBytes / 1024 : 0;
        const estimated_final_kb =
          percent > 0 ? (targetSizeKB / percent) * 100 : 0;

        // Only update if timemark advanced (avoids churn)
        if (timemark && timemark === lastTimemark) return;
        lastTimemark = timemark;

        const output = {
          // carry a few ffmpeg progress fields forward, similar to fluent-ffmpeg
          frames: frame,
          timemark,
          currentFps: progressBlock.fps ? Number(progressBlock.fps) : undefined,
          speed: progressBlock.speed,
          targetSize: targetSizeKB, // fluent-ffmpeg used KB
          startTime,
          refreshed: now,
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
              kb: targetSizeKB,
              mb: targetSizeKB / 1024,
              gb: targetSizeKB / 1024 / 1024
            },
            estimated_final: {
              kb: estimated_final_kb,
              mb: estimated_final_kb / 1024,
              gb: estimated_final_kb / 1024 / 1024,
              change: original_file_size_bytes
                ? `${
                    ((estimated_final_kb - original_file_size_bytes / 1024) /
                      (original_file_size_bytes / 1024)) *
                    100
                  }%`
                : 'calculating'
            },
            original: {
              kb: original_file_size_bytes / 1024,
              mb: original_file_size_bytes / 1024 / 1024,
              gb: original_file_size_bytes / 1024 / 1024 / 1024
            }
          },
          action: 'transcoding'
        };

        // Update the in-memory job record (kept intentionally small elsewhere)
        patchRunningJob(video_record._id, {
          ffmpeg_cmd,
          audio_language,
          file: inputFile,
          ...output
        });

        // If job appears stale, remove it (same safety behavior as before)
        const idx =
          global.transcodeQueue?.runningJobs?.findIndex(
            (j) => String(j._id) === String(video_record._id)
          ) ?? -1;
        if (idx !== -1) {
          const refreshed =
            global.transcodeQueue.runningJobs[idx]?.refreshed || 0;
          if (refreshed < Date.now() - 8 * 60 * 60 * 1000) {
            logger.warn(`Removing stalled job ${video_record._id}`);
            global.transcodeQueue.runningJobs =
              global.transcodeQueue.runningJobs.filter(
                (j) => String(j._id) !== String(video_record._id)
              );
          }
        }
      };

      rlOut.on('line', (line) => {
        // Each progress line is key=value; blocks end with `progress=continue` or `progress=end`
        const trimmed = String(line || '').trim();
        if (!trimmed) return;
        const eq = trimmed.indexOf('=');
        if (eq === -1) return;
        const key = trimmed.slice(0, eq);
        const value = trimmed.slice(eq + 1);

        progressBlock[key] = value;

        if (key === 'progress') {
          flushProgressBlock();
          progressBlock = {};
        }
      });

      // Capture bounded stderr for debugging/error reporting
      const rlErr = readline.createInterface({ input: child.stderr });
      rlErr.on('line', (line) => {
        const msg = String(line || '').trim();
        if (!msg) return;
        stderrRing.push(msg);
      });

      // Handle process completion
      child.on('error', async (err) => {
        // Spawn-level error (e.g., ffmpeg not found)
        try {
          const stderr = stderrRing.toString();
          logger.error(err, { label: 'FFMPEG SPAWN ERROR', stderr });
          fs.appendFileSync(
            '/usr/app/logs/ffmpeg.log',
            JSON.stringify(
              {
                error: err.message,
                stderr,
                ffmpeg_cmd,
                trace: err.stack
              },
              null,
              4
            )
          );

          Object.assign(video_record, {
            error: { error: err.message, stderr, ffmpeg_cmd, trace: err.stack },
            hasError: true
          });
          await video_record.saveDebounce();

          await ErrorLog.create({
            path: inputFile,
            error: { error: err.message, stderr, ffmpeg_cmd, trace: err.stack }
          });

          await trash(scratch_file, false);
        } catch (e) {
          logger.error(e, { label: 'FFMPEG SPAWN ERROR HANDLER FAILED' });
        } finally {
          resolve({});
        }
      });

      child.on('close', async (code, signal) => {
        // Ensure readline interfaces are closed
        try {
          rlOut.close();
        } catch (e) {
          logger.warn('Failed to close rlOut', { error: e });
        }
        try {
          rlErr.close();
        } catch (e) {
          logger.warn('Failed to close rlErr', { error: e });
        }

        // If we ended normally, flush any partial progress once
        try {
          flushProgressBlock();
        } catch (e) {
          logger.warn('Failed to flush progress block', { error: e });
        }

        // Success path
        if (code === 0) {
          try {
            logger.info(`Transcode complete for file: ${inputFile}`);
            await wait(5);

            if (!fs.existsSync(scratch_file)) {
              throw new Error(
                `Scratch file ${scratch_file} not found after transcode complete.`
              );
            }

            // Finalizing step: move scratch_file to dest_file
            const moveStartTime = Date.now();
            let moveInterval;
            const scratchSize = (await stat(scratch_file)).size;

            if (scratchSize > 0) {
              moveInterval = setInterval(() => {
                try {
                  if (fs.existsSync(dest_file)) {
                    const destStats = fs.statSync(dest_file);
                    const copied = destStats.size;
                    const percent = Math.min(
                      (copied / scratchSize) * 100,
                      100
                    ).toFixed(2);
                    const elapsed = (Date.now() - moveStartTime) / 1000;
                    const pct_per_second = Number(percent) / elapsed;
                    const seconds_pct =
                      pct_per_second > 0 ? 1 / pct_per_second : Infinity;
                    const pct_remaining = 100 - Number(percent);
                    const est_completed_seconds = pct_remaining * seconds_pct;
                    const est_completed_timestamp =
                      Date.now() + est_completed_seconds * 1000;
                    const time_remaining = formatSecondsToHHMMSS(
                      est_completed_seconds
                    );
                    const currentKbps =
                      elapsed > 0
                        ? Math.round((copied * 8) / 1024 / elapsed)
                        : 0;

                    logger.debug(
                      `${dest_file} move progress: ${percent}% (${copied}/${scratchSize} bytes, ${currentKbps} kbps)`
                    );
                    patchRunningJob(video_record._id, {
                      percent,
                      est_completed_timestamp,
                      time_remaining,
                      action: 'finalizing',
                      currentKbps,
                      moveStartTime
                    });
                  }
                } catch (e) {
                  logger.error(e, { label: 'Dest file move progress error' });
                }
              }, 1000);
            }

            await moveFile(scratch_file, dest_file);

            // if the file and dest_file are not the same, delete the original file
            if (dest_file !== original_file) {
              logger.info(
                `Deleting original file after transcode: ${original_file}`
              );
              await trash(original_file, true);
            }

            if (moveInterval) clearInterval(moveInterval);

            // After move, report 100% progress
            const percent = 100;
            const time_remaining = formatSecondsToHHMMSS(0);
            const est_completed_timestamp = Date.now();
            const elapsed = (est_completed_timestamp - moveStartTime) / 1000;
            const currentKbps =
              elapsed > 0 ? Math.round((scratchSize * 8) / 1024 / elapsed) : 0;

            logger.debug(
              `${dest_file} move complete: 100% (${scratchSize}/${scratchSize} bytes, ${currentKbps} kbps)`
            );
            patchRunningJob(video_record._id, {
              percent,
              est_completed_timestamp,
              time_remaining,
              action: 'finalizing',
              currentKbps,
              moveStartTime
            });

            // Delete stage_file if it exists
            if (stage_file && fs.existsSync(stage_file)) {
              try {
                await fs.promises.unlink(stage_file);
                logger.debug(
                  `Deleted stage_file after transcode: ${stage_file}`
                );
              } catch (stageDelErr) {
                logger.warn(
                  `Failed to delete stage_file: ${stage_file}`,
                  stageDelErr
                );
              }
            }

            await fs.promises.utimes(dest_file, new Date(), new Date());
            global.processed_files_delta += 1;

            const dest_file_size = (await stat(dest_file)).size;

            // Remove staged input (if we transcoded from stage or scratch)
            if (dest_file !== inputFile) {
              await trash(inputFile, false);
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
          return;
        }

        // Error path: capture bounded stderr, preserve your previous behavior as much as possible
        try {
          const stderr = stderrRing.toString();
          const errMsg = `ffmpeg exited with code=${code} signal=${
            signal || 'none'
          }`;

          // Detect hwaccel init failures (your prior retry logic looked for "251")
          if (/251/i.test(stderr) || /251/i.test(errMsg)) {
            logger.warn(
              'FFmpeg error 251 detected. Disabling hardware acceleration for this video.'
            );
            video_record.permitHWDecode = false;
          }

          logger.error(
            { code, signal, stderr: stderr.slice(-2000) },
            { label: 'Cannot process video (ffmpeg exit)' }
          );

          fs.appendFileSync(
            '/usr/app/logs/ffmpeg.log',
            JSON.stringify(
              {
                error: errMsg,
                stderr,
                ffmpeg_cmd
              },
              null,
              4
            )
          );

          await trash(scratch_file, false);

          Object.assign(video_record, {
            error: { error: errMsg, stderr, ffmpeg_cmd },
            hasError: true
          });
          await video_record.saveDebounce();

          await ErrorLog.create({
            path: inputFile,
            error: { error: errMsg, stderr, ffmpeg_cmd }
          });
        } catch (e) {
          logger.error(e, { label: 'FFMPEG ERROR HANDLER FAILED' });
        } finally {
          resolve({});
        }
      });
    } catch (e) {
      // Top-level error: log, update Mongo record, cleanup
      logger.error(e, { label: 'TRANSCODE ERROR' });
      await upsert_video({
        path: file?.path || file,
        error: { error: e.message, trace: e.stack },
        hasError: true
      });
      await ErrorLog.create({
        path: file?.path || file,
        error: { error: e.message, trace: e.stack }
      });

      // Trash file if no video/audio stream or file not found
      if (/no\s+(video|audio)\s+stream\s+found/gi.test(e.message)) await trash(file?.path || file);
      if (/file\s+not\s+found/gi.test(e.message)) await trash(file?.path || file);

      // Ensure child is cleaned up if partially started
      try {
        if (child && !child.killed) child.kill('SIGKILL');
      } catch (e) {
        logger.warn('Failed to kill child process', { error: e });
      }

      resolve({});
    }
  });
}
