import fs from 'fs';
import dayjs from './dayjs';
import ffprobe from './ffprobe';
import upsert_video from './upsert_video';
import { trash } from './fs';
import tmdb_api from './tmdb_api';
import File from '../models/files';
import language_map from './lang';
import config from './config';
import logger from './logger';
import { log } from 'console';

const { encode_version } = config;

/**
 * Probe a media file and upsert its metadata into MongoDB.
 *
 * This function is intentionally "ffprobe-first" when it decides a probe is needed.
 * To keep the nightly safety sweep efficient, it supports skipping ffprobe when a cheap
 * filesystem fingerprint matches what we previously stored.
 *
 * Skipping strategy (no file hashing):
 * - Read `fs.stat()` (metadata only).
 * - Compare {size, mtimeMs, ctimeMs, ino} against `fsFingerprint` stored in Mongo.
 * - If identical and we already have a probe payload, skip ffprobe + TMDB enrichment.
 *
 * Terminology:
 * - `last_seen`: the file was encountered during a sweep.
 * - `last_probe`: ffprobe actually ran and the probe payload was stored.
 *
 * @param {string} file Absolute file path.
 * @param {string|null} record_id Optional Mongo record id to force an update by id.
 * @param {Object=} opts Additional fields to merge into the upsert.
 * @param {boolean=} opts.force_probe If true, always run ffprobe even when unchanged.
 * @param {boolean=} opts.touch_last_seen If true, update `last_seen` even when skipping.
 * @returns {Promise<Object|false>} ffprobe payload if probed, or false if skipped/failed.
 */
export default async function probe_and_upsert (file, record_id = null, opts = {}) {
  // Normalize any trailing newlines from `find` output.
  file = String(file).replace(/\n+$/, '');

  const { force_probe = false } = opts;

  try {
    const current_time = dayjs();

    // Guard: if the path is gone, trash the record/file and stop.
    if (!fs.existsSync(file)) {
      throw new Error('File not found');
    }

    // NOTE: stat is extremely cheap compared to ffprobe or hashing. It reads inode metadata only.
    const st = fs.statSync(file);

    // On Linux, these fields are stable and very effective for change detection.
    // - size: content size in bytes
    // - mtimeMs: last content modification timestamp (can be preserved by some copy tools)
    // - ctimeMs: inode change timestamp (updates when content changes even if mtime preserved)
    // - ino: inode number (helps distinguish replace-vs-edit scenarios)
    const fsFingerprint = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      inode: st.ino,
      dev: st.dev
    };

    // Prefer looking up by path. record_id is preserved for callers that want to force a specific doc.
    const query = record_id ? { _id: record_id } : { path: file };
    const video_record = await File.findOne(query);

    const alreadyHasProbe = Boolean(video_record?.probe);
    const prev = video_record?.fsFingerprint;

    const fingerprintMatches =
      prev &&
      prev.size === fsFingerprint.size &&
      prev.mtimeMs === fsFingerprint.mtimeMs &&
      prev.ctimeMs === fsFingerprint.ctimeMs &&
      // inode/dev comparisons are best-effort: if not present, don't block skip.
      (prev.inode == null || prev.inode === fsFingerprint.inode) &&
      (prev.dev == null || prev.dev === fsFingerprint.dev);

    // Fast-path: unchanged file with an existing probe payload.
    // Skip ffprobe + enrichment, no last_seen update for performance.
    if (!force_probe && alreadyHasProbe && fingerprintMatches) {
      logger.info(`Skipping probe for unchanged file: ${file}`);
      return video_record?.probe || false;
    } else {
      logger.info(`Probing file: ${file}`);
    }

    // Full-path: run ffprobe and enrichment exactly as before.
    const ffprobe_data = await ffprobe(file);
    // TMDB enrichment is called for side-effects / caching in this codebase.
    // If you later decide to persist it, add a schema field and include it in the upsert.
    await tmdb_api(file);

    // Normalize audio languages from ffprobe stream metadata.
    // Use array iteration to extract audio languages, avoiding for...of and continue.
    let languages = [];
    try {
      languages = (ffprobe_data?.streams ?? [])
        .filter((stream) => stream?.codec_type === 'audio' && stream?.tags?.language)
        .map((stream) => language_map[stream.tags.language] || stream.tags.language);
    } catch (e) {
      // Language parsing errors should never fail the probe.
      logger.warn(`Language parsing failed for ${file}`, { error: e });
    }

    await upsert_video({
      record_id,
      path: file,
      probe: ffprobe_data,
      encode_version: ffprobe_data?.format?.tags?.ENCODE_VERSION,
      status: ffprobe_data?.format?.tags?.ENCODE_VERSION === encode_version ? 'complete' : 'pending',
      last_probe: current_time,
      fsFingerprint,
      sortFields: {
        width: ffprobe_data?.streams?.find((s) => s.codec_type === 'video')?.width,
        size: ffprobe_data?.format?.size
      },
      audio_language: languages,
      ...opts
    });

    return ffprobe_data;
  } catch (e) {
    // If the file is missing, keep your existing behavior: move to trash.
    if (/file\s+not\s+found/gi.test(e.message)) {
      await trash(file);
    }

    logger.error(`Probe and upsert failed for ${file}`, { error: e });
    return false;
  }
}
