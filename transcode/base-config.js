const config = {
  encode_version: "20230608a",
  concurrent_file_checks: 30,
  profiles: [
    {
      name: "uhd",
      width: 3840,
      aspect: 16 / 9,
      bitrate: 25,
    },
    {
      name: "1080p",
      width: 1920,
      aspect: 16 / 9,
      bitrate: 7,
    },
    {
      name: "720p",
      width: 720,
      dest_width: 1920,
      aspect: 16 / 9,
      bitrate: 7,
    },
    {
      name: "hdv (1440p)",
      width: 1440,
      aspect: 4 / 3,
      bitrate: 7,
    },
    {
      name: "sd",
      width: 480,
      aspect: 4 / 3,
      bitrate: 3.5,
    },
    {
      name: "vertical",
      width: 1080,
      aspect: 9 / 16,
      bitrate: 12,
    },
  ],

  dest_formats: {
    av1: {
      video: {
        codec: "libsvtav1",
        codec_name: "av1",
        flags: {
          crf: 35,
          preset: 8,
        },
      },
      audio: {
        codec: "libopus",
        codes_name: "opus",
        per_channel_bitrate: 56,
        downmix: true, // downmix to stereo in a duplicate channel
      },
    },
  },
};

config.profiles = config.profiles
  .map((x) => ({
    ...x,
    output: config.dest_formats.av1, // merge in the av1 defaults
    aspect: aspect_round(x.aspect),
  }))
  .map((x) => {
    x.output.video.bitrate = x.bitrate;
    return x;
  });

export default config;
