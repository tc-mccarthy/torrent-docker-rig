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

          // 1. Base score from resolution (relative to full 4K)
          const areaScore = (video.width * video.height) / (3840 * 2160);

          // 2. Bit depth factor: more bits per pixel = more memory per frame
          const bitDepth = parseInt(
            video.bits_per_raw_sample || video.bits_per_sample || '8',
            10
          );
          const bitDepthFactor = bitDepth > 8 ? 1.2 : 1;

          // 3. Pixel format: 4:2:2 or 4:4:4 subsampling increases memory
          const pixFmt = video.pix_fmt || '';
          const chromaFactor = (() => {
            if (pixFmt.includes('422')) return 1.1;
            if (pixFmt.includes('444')) return 1.3;
            return 1; // assume 4:2:0 (default)
          })();

          // 4. Audio stream multiplier: each extra audio track adds 5%
          const audioStreams = this.probe?.streams?.filter((s) => s.codec_type === 'audio') || [];
          const extraAudioCount = Math.max(audioStreams.length - 1, 0);
          const audioFactor = 1 + extraAudioCount * 0.05;

          // 5. Container complexity multiplier: more than 10 streams = 10% bump
          const streamCount = this.probe?.streams?.length || 1;
          const containerFactor = streamCount > 10 ? 1.1 : 1;

          // Final compute score focused purely on memory pressure
          const rawScore =
        areaScore *
        bitDepthFactor *
        chromaFactor *
        audioFactor *
        containerFactor;

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
