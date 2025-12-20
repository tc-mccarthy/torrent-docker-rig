import mongoose from 'mongoose';
import { getMinimum } from '../lib/round-compute-score';
import wait, { getRandomDelay } from '../lib/wait';
import logger from '../lib/logger';
import calculateComputeScore from '../lib/calculateComputeScore';

const { Schema, model } = mongoose;

/**
 * File model (MongoDB / Mongoose).
 *
 * This collection is the central record of truth for everything the transcoder/indexer knows
 * about a media file: where it lives (path), the latest ffprobe payload, transcode status,
 * enrichment metadata, and scheduling/prioritization helpers.
 *
 * Notes:
 * - Mongoose automatically pluralizes the model name to pick a collection (e.g., `File` -> `files`).
 * - `path` is treated as the stable unique identifier.
 */
const model_name = 'File';

// establish types and defaults for keys
/**
 * @typedef {Object} FileDocument
 * @property {string} path - Absolute file path (unique identifier).
 * @property {string=} encode_version - Encode version tag used to decide if a file needs re-encode.
 * @property {'pending'|'complete'|'ignore'|'error'} status - Current processing status.
 * @property {Object=} probe - Raw ffprobe payload (stored as-is).
 * @property {Date=} last_probe - Timestamp of the last successful ffprobe (not just "seen").
 * @property {Date=} last_seen - Timestamp of the most recent sweep that encountered this path.
 * @property {Object=} fsFingerprint - Cheap filesystem fingerprint used to skip unnecessary probing.
 * @property {Object=} transcode_details - Transcode job metadata (engine-specific).
 * @property {Object=} sortFields - Fields used for queue ordering (priority/size/width/etc).
 * @property {Array=} audio_language - Normalized audio languages detected from ffprobe.
 * @property {Object=} error - Error details if processing failed.
 * @property {boolean=} hasError - Convenience flag (mirrors error presence).
 * @property {boolean=} integrityCheck - Whether the file has passed/been scheduled for integrity checks.
 * @property {number=} computeScore - Heuristic cost score derived from probe and helpers.
 * @property {boolean=} permitHWDecode - Whether hardware decode is allowed for this file.
 * @property {number=} reclaimedSpace - Space savings estimate from transcode.
 * @property {Object=} indexerData - External enrichment payload (e.g., indexer tags).
 * @property {number=} effectiveBitrate - Derived bitrate used for prioritization/analytics.
 */

/**
 * Mongoose schema for File documents.
 * Includes all metadata, probe info, transcode details, and indexer enrichment.
 */
const schema = new Schema(
  {
    /**
     * File path (unique identifier for each file)
     */
    path: {
      type: String,
      required: false,
      unique: true
    },
    /**
     * Encode version (for tracking encoding changes)
     */
    encode_version: {
      type: String,
      required: false,
      index: true
    },
    /**
     * File status (pending, complete, error, etc.)
     */
    status: {
      type: String,
      required: true,
      index: true,
      default: 'pending'
    },
    /**
     * Probe data (ffprobe output)
     */
    probe: {
      type: Object,
      required: false
    },
    /**
     * Last probe date
     */
    last_probe: {
      type: Date,
      required: false
    },
    /**
     * Last time the indexer saw this file during a sweep.
     *
     * This is intentionally separate from `last_probe`, which is reserved for
     * "we actually ran ffprobe and stored the payload".
     */
    last_seen: {
      type: Date,
      required: false,
      index: true
    },
    /**
     * Filesystem fingerprint used to cheaply detect changes without reading file contents.
     *
     * On Linux local disks, `ctimeMs` is especially useful: it changes when the inode changes,
     * including content changes, even when tools preserve `mtime`.
     */
    fsFingerprint: {
      size: { type: Number, required: false, index: true }, // bytes
      mtimeMs: { type: Number, required: false, index: true }, // milliseconds since epoch
      ctimeMs: { type: Number, required: false, index: true }, // milliseconds since epoch
      inode: { type: Number, required: false }, // st.ino
      dev: { type: Number, required: false } // st.dev (optional)
    },

    /**
     * Transcode details (metadata about transcode operation)
     */
    transcode_details: {
      type: Object,
      required: false
    },
    /**
     * Sorting fields (priority, width, size, etc.)
     */
    sortFields: {
      type: Object,
      required: true
    },
    /**
     * Audio language(s)
     */
    audio_language: {
      type: Array,
      required: false
    },
    /**
     * Error details
     */
    error: {
      type: Object,
      required: false
    },
    /**
     * Error flag
     */
    hasError: {
      type: Boolean,
      required: false
    },
    /**
     * Integrity check flag
     */
    integrityCheck: {
      type: Boolean,
      required: false,
      default: false
    },
    /**
     * Compute score (auto-calculated from probe data)
     */
    computeScore: {
      type: Number,
      required: false,
      get (value) {
        try {
          // If the score is already set and >= minimum, return the stored value
          if (value && value >= getMinimum()) {
            return value;
          }
          // Calculate the compute score based on the probe data
          return calculateComputeScore(this);
        } catch (e) {
          // Gracefully handle any probe data issues and default conservatively
          logger.error(e, { label: 'COMPUTE SCORE ERROR' });
          logger.debug(this, { label: 'COMPUTE SCORE ERROR FILE' });
          return 1; // Fallback compute score
        }
      }
    },
    /**
     * Hardware decode permission
     * Indicates if hardware decoding is permitted for this file (e.g., for GPU acceleration).
     * Default is true to allow hardware decode unless explicitly disabled.
     */
    permitHWDecode: {
      type: Boolean,
      required: false,
      default: true
    },
    /**
     * Space reclaimed by file (in bytes)
     * Tracks the amount of disk space freed by deleting or transcoding this file.
     * Useful for reporting and disk management.
     */
    reclaimedSpace: {
      type: Number,
      required: false,
      default: 0
    },
    /**
     * Indexer metadata (Radarr/Sonarr enrichment)
     * Stores metadata imported from Radarr/Sonarr, such as tags, IDs, and poster URLs.
     * Used for UI enrichment and advanced filtering.
     */
    indexerData: {
      type: Object,
      required: false
    },

    /**
     * Effective bitrate (in bits/sec)
     * Calculated or imported bitrate for the file, used for playback and transcode decisions.
     */
    effectiveBitrate: {
      type: Number,
      required: false,
      default: 0
    }
  },
  /**
   * Mongoose schema options:
   * - timestamps: Automatically adds created_at and updated_at fields for audit/history.
   */
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/**
 * Debounced save method for File documents.
 * Prevents rapid consecutive saves from causing parallel write errors.
 * Retries on parallel error with a random delay between 250ms and 500ms.
 *
 * @function saveDebounce
 * @memberof FileDocument
 * @returns {Promise<void>} Resolves when save completes or retries.
 */
schema.methods.saveDebounce = async function saveDebounce () {
  if (this.saveTimeout) {
    clearTimeout(this.saveTimeout);
  }
  this.saveTimeout = setTimeout(async () => {
    try {
      await this.save();
      this.saveTimeout = null;
    } catch (e) {
      if (/parallel/i.test(e.message)) {
        await wait(getRandomDelay(0.25, 0.5));
        console.error('Retrying save after parallel error');
        this.saveDebounce();
      }
    }
  }, 250);
};

/**
 * Indexes for efficient queries on File documents.
 * Includes compound and single-field indexes for sortFields, status, probe, and error fields.
 * These indexes optimize queries for sorting, filtering, and bulk operations in the transcode pipeline.
 */
schema.index({ 'probe.format.size': 1 });
schema.index({ 'sortFields.width': -1, 'sortFields.size': 1 });
schema.index({ 'sortFields.priority': 1, 'sortFields.width': -1, 'sortFields.size': 1 });
schema.index({ 'sortFields.priority': 1, 'sortFields.width': -1, 'sortFields.size': -1 });
schema.index({ 'sortFields.priority': 1, 'sortFields.size': -1, 'sortFields.width': -1 });
schema.index({ 'sortFields.priority': 1 });
schema.index({ 'sortFields.size': 1 });
schema.index({ 'sortFields.width': -1 });
schema.index({ 'probe.streams[0].codec_name': 1 });
schema.index({ 'probe.streams.codec_name': 1 });
schema.index({ updated_at: -1 });
schema.index({ last_probe: -1 });
schema.index({ hasError: 1 });
schema.index({ encode_version: 1, status: 1 });
schema.index({ integrityCheck: 1, status: 1 });
/**
 * Compound index for priority and status.
 * Used for queries like: priority >= 90 and status = 'pending'.
 * This enables efficient scheduling and prioritization in the transcode queue.
 */
schema.index({ 'sortFields.priority': 1, status: 1 });

/**
 * Compound index for generating the file list
 *
 */
schema.index({
  status: 1,
  integrityCheck: 1,
  encode_version: 1,
  'sortFields.priority': 1,
  'sortFields.size': -1,
  'sortFields.width': -1
});

/**
 * Compound index for generating the file list
 *
 */
schema.index({
  status: 1,
  integrityCheck: 1,
  'sortFields.priority': 1,
  'sortFields.size': -1,
  'sortFields.width': -1
});

/**
 * Fast path for \"should we probe?\" checks.
 *
 * When we sweep lots of files, we frequently do lookups by `path` and compare fingerprint fields.
 */
schema.index({ path: 1, 'fsFingerprint.size': 1, 'fsFingerprint.mtimeMs': 1, 'fsFingerprint.ctimeMs': 1 });

// create a model object that uses the above schema
export default model(model_name, schema);
