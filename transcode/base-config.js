import copy from "fast-copy";

export function aspect_round(val) {
  return Math.round(val * 10) / 10;
}

const config = {
  encode_version: "20231113a",
  concurrent_file_checks: 30,
  profiles: [
    {
      name: "uhd",
      width: 3840,
      aspect: 16 / 9,
      bitrate: 10,
      crf: 35,
      output: "av1",
    },
    {
      name: "1080p",
      width: 1920,
      aspect: 16 / 9,
      bitrate: 7,
      crf: 35,
      output: "av1",
    },
    {
      name: "720p",
      width: 720,
      dest_width: 1920,
      aspect: 16 / 9,
      bitrate: 7,
      crf: 35,
      output: "av1",
    },
    {
      name: "hdv (1440p)",
      width: 1440,
      aspect: 4 / 3,
      bitrate: 7,
      crf: 35,
      output: "av1",
    },
    {
      name: "sd",
      width: 480,
      aspect: 4 / 3,
      bitrate: 3.5,
      crf: 50,
      output: "av1",
    },
    {
      name: "vertical",
      width: 1080,
      aspect: 9 / 16,
      bitrate: 12,
      crf: 35,
      output: "av1",
    },
  ],

  dest_formats: {
    av1: {
      video: {
        codec: "libsvtav1",
        codec_name: "av1",
        flags: {
          crf: 35,
          preset: 6,
        },
      },
      audio: {
        codec: "libopus",
        codes_name: "opus",
        per_channel_bitrate: 64,
        downmix: true, // downmix to stereo in a duplicate channel
      },
    },
  },
  build_profiles: function (config) {
    config.profiles = config.profiles
      .map((x) => ({
        ...x,
        output: config.dest_formats[x.output] || config.dest_formats.av1, // merge in the defaults for the output profile specified
        aspect: aspect_round(x.aspect),
      }))
      .map((x) => {
        x.output.video.bitrate = x.bitrate;
        return x;
      });
  },
  get_profile: function (video_stream) {
    // locate the conversion profile that's best suited for this source media and duplicate it so changes don't propagate to the next use of the profile
    let conversion_profile = config.profiles.find(
      (x) =>
        video_stream.width + 10 >= x.width && video_stream.aspect >= x.aspect
    );

    if (conversion_profile) {
      conversion_profile = copy(conversion_profile);
      conversion_profile.output.video.bitrate = conversion_profile.bitrate;
      conversion_profile.output.video.flags.crf = conversion_profile.crf;
      conversion_profile.output.video.addFlags = function (flags) {
        Object.assign(conversion_profile.output.video.flags, flags);
      };
      return conversion_profile;
    }

    throw new Error(
      "No suitable conversion profile could be found for this video stream"
    );
  },
};

config.build_profiles(config);

export default config;
