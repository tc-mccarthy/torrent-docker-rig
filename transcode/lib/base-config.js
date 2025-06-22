import copy from 'fast-copy';

export function aspect_round (val) {
  return Math.round(val * 10) / 10;
}

const config = {
  encode_version: '20250108a',
  concurrent_file_checks: process.env.CONCURRENT_FILE_CHECKS || 50,
  concurrent_transcodes: process.env.CONCURRENT_TRANSCODES || 1,
  concurrent_integrity_checks: process.env.CONCURRENT_INTEGRITY_CHECKS || 1,
  profiles: [
    {
      name: 'uhd',
      width: 3840,
      height: 2160,
      aspect: 16 / 9,
      flags: {
        crf: 28,
        preset: 8,
        tune: 0,
        maxrate: '40M',
        bufsize: '120M'
      },
      output: 'av1'
    },
    {
      name: 'uhd (academy)',
      width: 2960,
      height: 2160,
      aspect: 1.37 / 1,
      flags: {
        crf: 28,
        preset: 8,
        tune: 0,
        maxrate: '40M',
        bufsize: '120M'
      },
      output: 'av1'
    },
    {
      name: '1080p',
      width: 1920,
      height: 1080,
      aspect: 16 / 9,
      flags: {
        crf: 30,
        preset: 8,
        tune: 0,
        maxrate: '10M',
        bufsize: '40M'
      },
      output: 'av1'
    },
    {
      name: '1080p academy',
      width: 1920,
      height: 1396,
      aspect: 1.37 / 1,
      flags: {
        crf: 30,
        preset: 8,
        tune: 0,
        maxrate: '10M',
        bufsize: '40M'
      },
      output: 'av1'
    },
    {
      name: 'hdv (1440p)',
      width: 1440,
      height: 1080,
      aspect: 4 / 3,
      flags: {
        crf: 30,
        preset: 8,
        tune: 0,
        maxrate: '10M',
        bufsize: '40M'
      },
      output: 'av1'
    },
    {
      name: '720p',
      width: 1280,
      height: 720,
      aspect: 16 / 9,
      flags: {
        crf: 30,
        preset: 8,
        tune: 0,
        maxrate: '10M',
        bufsize: '40M'
      },
      output: 'av1'
    },
    {
      name: 'sd',
      width: 720,
      height: 480,
      aspect: 4 / 3,
      bitrate: 3.5,
      flags: {
        crf: 30,
        preset: 8,
        tune: 0,
        maxrate: '10M',
        bufsize: '40M'
      },
      output: 'av1',
      default: true
    },
    {
      name: 'vertical',
      width: 1080,
      height: 1920,
      aspect: 9 / 16,
      bitrate: 12,
      flags: {
        crf: 30,
        preset: 8,
        tune: 0,
        maxrate: '10M',
        bufsize: '40M'
      },
      output: 'av1'
    }
  ],
  file_ext: [
    'avi',
    'mkv',
    'm4v',
    'flv',
    'mov',
    'wmv',
    'webm',
    'gif',
    'mpg',
    'mp4',
    'm2ts'
  ],
  dest_formats: {
    av1: {
      video: {
        codec: 'libsvtav1',
        codec_name: 'av1',
        flags: {
          max_muxing_queue_size: 9999,
          pix_fmt: 'yuv420p10le'
        }
      },
      audio: {
        codec: 'libfdk_aac',
        codec_name: 'aac',
        per_channel_bitrate: 96,
        downmix: true // downmix to stereo in a duplicate channel
      }
    }
  },
  build_profiles (config) {
    config.profiles = config.profiles
      .map((x) => ({
        ...x,
        output: (config.dest_formats[x.output] || config.dest_formats.av1), // merge in the defaults for the output profile specified
        aspect: aspect_round(x.aspect)
      })).map((x) => {
        x.output.video.flags = {
          ...(x.output.video.flags || {}), // default flags
          ...(x.flags || {}) // profile overrides and extensions
        };
        return x;
      });
  },
  get_profile (video_stream) {
    // locate the conversion profile that's best suited for this source media and duplicate it so changes don't propagate to the next use of the profile
    let conversion_profile = config.profiles.find(
      (x) =>
        (video_stream.width + 50 >= x.width) && Math.abs(video_stream.aspect) >= x.aspect
    );

    // if no profile was found, use the default profile
    if (!conversion_profile) {
      conversion_profile = config.profiles.find((p) => p.default);
    }

    // copy the profile so changes don't propagate to the next use of the profile
    conversion_profile = copy(conversion_profile);

    // add a function to add flags to the output video profile
    conversion_profile.output.video.addFlags = function (flags) {
      Object.assign(conversion_profile.output.video.flags, flags);
    };

    return conversion_profile;
  },

  get_paths (config) {
    return config.sources.map((p) => p.path);
  }
};

config.build_profiles(config);

export default config;
