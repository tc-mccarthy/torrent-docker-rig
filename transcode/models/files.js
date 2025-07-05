import mongoose from 'mongoose';
import dayjs from '../lib/dayjs';
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
    lock: {
      integrity: {
        type: Date,
        required: false,
        default: null,
        index: true
      },
      transcode: {
        type: Date,
        required: false,
        default: null,
        index: true
      }
    },
    computeScore: {
      type: Number,
      required: false,
      get (value) {
        try {
        // return the stored value.
          if (value && value >= getMinimum()) {
            return value;
          }
          const video_stream = this.probe?.streams?.find((s) => s.codec_type === 'video');
          if (!video_stream) {
            throw new Error('No video stream found in probe data');
          }
          const calculatedScore = (video_stream.width * video_stream.height) / (3840 * 2160); // take the video area and divide it by 4K resolution area
          return roundComputeScore(calculatedScore);
        } catch (e) {
          logger.error(e, { label: 'COMPUTE SCORE ERROR' });
          logger.info(this, { label: 'COMPUTE SCORE ERROR FILE' });
          return 1; // default to 100 if there's an error
        }
      }
    },
    permitHWDecode: {
      type: Boolean,
      required: false,
      default: true
    }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

schema.methods.setLock = async function (type, sec = 30) {
  if (!type) {
    throw new Error('Type is required to set a lock');
  }

  this.lock[type] = dayjs().add(sec, 'seconds').toDate();
  await this.saveDebounce();

  schema[`${type}lockTimeout`] = setTimeout(() => {
    this.setLock(type, sec);
  }, sec * 0.75 * 1000);
};

schema.methods.clearLock = async function (type) {
  if (!type) {
    throw new Error('Type is required to clear a lock');
  }

  if (schema[`${type}lockTimeout`]) {
    clearTimeout(schema[`${type}lockTimeout`]);
    schema[`${type}lockTimeout`] = null;
  }

  this.lock[type] = null;
  await this.saveDebounce();
};

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
