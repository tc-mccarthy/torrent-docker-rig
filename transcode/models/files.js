import mongoose from 'mongoose';
import roundComputeScore, { getMinimum } from '../lib/round-compute-score';
import wait, { getRandomDelay } from '../lib/wait';
import logger from '../lib/logger';

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
const schema = new Schema(
  {
    path: {
      type: String,
      required: false,
      unique: true
    },
    encode_version: {
      type: String,
      required: false,
      index: true
    },
    status: {
      type: String,
      required: true,
      index: true,
      default: 'pending'
    },
    probe: {
      type: Object,
      required: false // making this false so that we can easily add registration to the site without needing a subscription
    },
    last_probe: {
      type: Date,
      required: false
    },
    transcode_details: {
      type: Object,
      required: false
    },
    sortFields: {
      type: Object,
      required: true
    },
    audio_language: {
      type: Array,
      required: false
    },
    error: {
      type: Object,
      required: false
    },
    hasError: {
      type: Boolean,
      required: false
    },
    integrityCheck: {
      type: Boolean,
      required: false,
      default: false
    },

    computeScore: {
      type: Number,
      required: false,
      get (value) {
        try {
          // If the score is already set and >= minimum, return the stored value
          if (value && value >= getMinimum()) {
            return value;
          }

          // Extract the first video stream from ffprobe data
          const video = this.probe?.streams?.find((s) => s.codec_type === 'video');
          if (!video) throw new Error('No video stream found in probe data');

          // 1. Base compute score from resolution (normalized to 4K area)
          const areaScore = (video.width * video.height) / (3840 * 2160);

          // 2. Bitrate factor (normalize against 20 Mbps baseline for 4K)
          const bitrate = parseInt(video.bit_rate || this.probe?.format?.bit_rate || 0, 10);
          // Cap at 1.5x to prevent extremely high bitrates from skewing too much
          const bitrateFactor = bitrate ? Math.min(bitrate / 20000000, 1.5) : 1;

          // 3. Framerate factor (normalize to 30 fps)
          let framerate = 30;
          if (video.avg_frame_rate && video.avg_frame_rate.includes('/')) {
            const [num, den] = video.avg_frame_rate.split('/').map(Number);
            if (den !== 0) framerate = num / den;
          }
          const framerateFactor = framerate / 30;

          // 4. Codec multiplier (reflects relative decode/transcode complexity)
          const codec = video.codec_name || '';
          const codecMultiplier = (() => {
            if (codec.includes('hevc') || codec.includes('h265')) return 1.5; // HEVC is heavier
            if (codec.includes('vp9')) return 1.8;
            if (codec.includes('av1')) return 2.5; // AV1 is significantly more expensive
            return 1; // Default: assume H.264 or similar
          })();

          // 5. Optional: Bit depth factor (10-bit video uses more memory)
          const bitDepth = parseInt(video.bits_per_raw_sample || video.bits_per_sample || '8', 10);
          const bitDepthFactor = bitDepth > 8 ? 1.2 : 1;

          // Combine all the factors into a final raw compute score. The factors additional to the area score can only increase the score, not decrease it.
          // This ensures that the score is always at least the area score.
          const rawScore = Math.max(areaScore * bitrateFactor * framerateFactor * codecMultiplier * bitDepthFactor, areaScore);

          // Round it
          return roundComputeScore(rawScore);
        } catch (e) {
          // Gracefully handle any probe data issues and default conservatively
          logger.error(e, { label: 'COMPUTE SCORE ERROR' });
          logger.debug(this, { label: 'COMPUTE SCORE ERROR FILE' });
          return 1; // Fallback compute score
        }
      }
    },
    permitHWDecode: {
      type: Boolean,
      required: false,
      default: true
    },
    reclaimedSpace: {
      type: Number,
      required: false,
      default: 0
    }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

schema.methods.saveDebounce = async function () {
  if (this.saveTimeout) {
    clearTimeout(this.saveTimeout);
  }
  this.saveTimeout = setTimeout(async () => {
    try {
      await this.save();
      this.saveTimeout = null;
    } catch (e) {
      if (/parallel/i.test(e.message)) {
        await wait(getRandomDelay(0.25, 0.5)); // wait a random time between 1/4 and 1/2 seconds

        console.error('Retrying save after parallel error');
        this.saveDebounce(); // retry saving after an error
      }
    }
  }, 250);
};

schema.index({ 'probe.format.size': 1 });
schema.index({ 'sortFields.width': -1, 'sortFields.size': 1 });
schema.index({
  'sortFields.priority': 1,
  'sortFields.width': -1,
  'sortFields.size': 1
});
schema.index({
  'sortFields.priority': 1,
  'sortFields.width': -1,
  'sortFields.size': -1
});
schema.index({
  'sortFields.priority': 1,
  'sortFields.size': -1,
  'sortFields.width': -1
});
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

// create a model object that uses the above schema
export default model(model_name, schema);
