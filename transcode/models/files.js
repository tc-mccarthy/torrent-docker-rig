const mongoose = require("mongoose");
const { Schema, model } = mongoose;

/**
 *  Mongoose docs say this value should be the singular word for the collection we want this stored in.
 * It's common practice to capitalize class names so I have made this guy User, which is what a single document would represent
 * This model will now automatically read and write from the `users` collection in our database
 *
 * Note: This is being done as a variable so that you can simply dupe this file and change the model_name and schema to readily create a new model
 * */
const model_name = "File";

//establish types and defaults for keys
const schema = new Schema(
  {
    path: {
      type: String,
      required: false,
      unique: true,
    },
    encode_version: {
      type: String,
      required: false,
      index: true,
    },
    probe: {
      type: Object,
      required: false, // making this false so that we can easily add registration to the site without needing a subscription
    },
    error: {
      type: Object,
      required: false,
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

// create a model object that uses the above schema
module.exports = model(model_name, schema);
