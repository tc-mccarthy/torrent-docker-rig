import mongoose from 'mongoose';
import { getMinimum } from '../lib/round-compute-score';
import wait, { getRandomDelay } from '../lib/wait';
import logger from '../lib/logger';
import calculateComputeScore from '../lib/calculateComputeScore';

const { Schema, model } = mongoose;

/**
 *  Mongoose docs say this value should be the singular word for the collection we want this stored in.
 * It's common practice to capitalize class names so I have made this guy User, which is what a single document would represent
 * This model will now automatically read and write from the `users` collection in our database
 *
 * Note: This is being done as a variable so that you can simply dupe this file and change the model_name and schema to readily create a new model
 * */
const model_name = 'File';

// establish types and defaults for keys
/**
 * @typedef {Object} FileDocument
 * @property {string} path - File path (unique)
 * @property {string} encode_version - Encode version
 * @property {string} status - File status (default: 'pending')
 * @property {Object} probe - Probe data (ffprobe output)
 * @property {Date} last_probe - Last probe date
 * @property {Object} transcode_details - Transcode details
 * @property {Object} sortFields - Sorting fields (priority, width, size, etc.)
 * @property {Array} audio_language - Audio language(s)
 * @property {Object} error - Error details
 * @property {Boolean} hasError - Error flag
 * @property {Boolean} integrityCheck - Integrity check flag
 * @property {Number} computeScore - Compute score (auto-calculated)
 * @property {Boolean} permitHWDecode - Hardware decode permission
 * @property {Number} reclaimedSpace - Space reclaimed by file
 * @property {Object} indexerData - Indexer metadata (Radarr/Sonarr)
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

// create a model object that uses the above schema
export default model(model_name, schema);
