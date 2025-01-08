import copy from "fast-copy";

export function aspect_round(val) {
  return Math.round(val * 10) / 10;
}

const config = {
  encode_version: "20231113a",
  concurrent_file_checks: 50,
  profiles: [
    {
      name: "uhd",
      width: 3840,
      height: 2160,
      aspect: 16 / 9,
      bitrate: 10,
      crf: 35,
      output: "av1",
    },
    {
      name: "1080p",
      width: 1920,
      height: 1080,
      aspect: 16 / 9,
      bitrate: 7,
      crf: 35,
      output: "av1",
    },
    {
      name: "hdv (1440p)",
      width: 1440,
      height: 1080,
      aspect: 4 / 3,
      bitrate: 7,
      crf: 35,
      output: "av1",
    },
    {
      name: "720p",
      width: 1280,
      height: 720,
      dest_width: 1920,
      aspect: 16 / 9,
      bitrate: 7,
      crf: 35,
      output: "av1"
    },
    {
      name: "sd",
      width: 720,
      height: 480,
      aspect: 4 / 3,
      bitrate: 3.5,
      crf: 50,
      output: "av1",
      default: true
    },
    {
      name: "vertical",
      width: 1080,
      height: 1920,
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
          preset: 7
        },
      },
      audio: {
        codec: "libfdk_aac",
        codec_name: "aac",
        per_channel_bitrate: 96,
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
        (video_stream.width + 50 >= x.width) && Math.abs(video_stream.aspect) >= x.aspect
    );

    // if no profile was found, use the default profile
    if(!conversion_profile) {
      conversion_profile = config.profiles.find(p => p.default);
    }

    // copy the profile so changes don't propagate to the next use of the profile
    conversion_profile = copy(conversion_profile);

    // set the output video bitrate and crf to the profile's values
    conversion_profile.output.video.bitrate = conversion_profile.bitrate;
    conversion_profile.output.video.flags.crf = conversion_profile.crf;

    // add a function to add flags to the output video profile
    conversion_profile.output.video.addFlags = function (flags) {
      Object.assign(conversion_profile.output.video.flags, flags);
    };
    
    return conversion_profile;    
  }
};

config.build_profiles(config);

export default config;
