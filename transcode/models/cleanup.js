import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 *  Mongoose docs say this value should be the singular word for the collection we want this stored in.
 * It's common practice to capitalize class names so I have made this guy User, which is what a single document would represent
 * This model will now automatically read and write from the `users` collection in our database
 *
 * Note: This is being done as a variable so that you can simply dupe this file and change the model_name and schema to readily create a new model
 * */
const model_name = 'Cleanup';

// establish types and defaults for keys
const schema = new Schema(
  {
    paths: [
      {
        type: String,
        required: false
      }
    ],
    count: {
      type: Number,
      required: false
    }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// create a model object that uses the above schema
export default model(model_name, schema);
