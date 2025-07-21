/**
 * Generates transcoding instructions based on ffprobe and metadata (TMDb/TVDb) in a mongo document.
 *
 * This function analyzes video, audio, and subtitle streams and determines whether to copy or transcode
 * based on stream characteristics (e.g., codec, size, resolution, HDR metadata). This version includes:
 * - Dynamic GOP size calculation for improved Plex compatibility
 * - Usage of `-avoid_negative_ts make_zero` to fix negative timestamps
 * - SVT-AV1 `usage` and `tier` tuning for better encode control
 *
 * @param {Object} mongoDoc - The Mongo document containing ffprobe and metadata info.
 * @returns {{
 *   video: {
 *     stream_index: number,
 *     codec: string,
 *     arguments: Object
 *   },
 *   audio: Array<{
 *     stream_index: number,
 *     language: string,
 *     codec: string,
 *     bitrate?: string
 *   }>,
 *   subtitles: Array<{
 *     stream_index: number,
 *     codec: string
 *   }>
 * }} - Transcoding instruction object.
 */
export function generateTranscodeInstructions (mongoDoc) {
  const {
    probe: ffprobe,
    audio_language = []
  } = mongoDoc;

  const streams = ffprobe.streams || [];
  const format = ffprobe.format || {};
  const fileSizeKB = parseInt(format.size || 0, 10);
  const fileSizeGB = fileSizeKB / (1024 ** 2);

  // Split streams by type
  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');

  const spokenLangs = audio_language.map((lang) => lang.toLowerCase());

  const result = {
    video: null,
    audio: [],
    subtitles: []
  };

  const mainVideo = videoStreams[0];
  if (!mainVideo) throw new Error('No video stream found');

  const videoCodec = mainVideo.codec_name;
  const isHEVC = videoCodec === 'hevc' || videoCodec === 'h265';
  const width = mainVideo.width || 0;
  const isUHD = width >= 3840;

  console.log(`Processing video stream: ${videoCodec}, width: ${width}, size: ${fileSizeGB.toFixed(2)} GB`);

  if (fileSizeGB <= 1 && isHEVC) {
    result.video = {
      stream_index: mainVideo.index,
      codec: 'copy',
      arguments: {}
    };
  } else {
    const hdrProps = {};
    if (mainVideo.color_transfer?.includes('2084')) {
      hdrProps.color_primaries = mainVideo.color_primaries;
      hdrProps.color_trc = mainVideo.color_transfer;
      hdrProps.colorspace = mainVideo.color_space;

      const sideData = mainVideo.side_data_list || [];
      const masteringDisplay = sideData.find((d) => d.side_data_type === 'Mastering display metadata');
      const contentLightLevel = sideData.find((d) => d.side_data_type === 'Content light level metadata');

      if (masteringDisplay) {
        hdrProps.master_display = masteringDisplay.mastering_display_metadata;
      }
      if (contentLightLevel) {
        hdrProps.cll = contentLightLevel.content_light_level_metadata;
      }
    }

    result.video = {
      stream_index: mainVideo.index,
      codec: 'libsvtav1',
      arguments: {
        pix_fmt: 'yuv420p10le',
        max_muxing_queue_size: 9999,
        tune: 0,
        usage: 0, // Low latency good quality (0 = best quality)
        tier: 0, // Main tier
        sc_threshold: 0,
        avoid_negative_ts: 'make_zero', // Fix for Plex timestamp handling
        g: calculateGOP(mainVideo), // Dynamically determined GOP size
        keyint_min: calculateGOP(mainVideo), // Min GOP size
        preset: determinePreset(isUHD, fileSizeGB),
        crf: getCrfForResolution(width),
        ...getRateControl(width),
        ...hdrProps
      }
    };
  }

  const filteredAudio = audioStreams
    .filter((s) => {
      const lang = (s.tags?.language || 'und').toLowerCase();
      return spokenLangs.includes(lang);
    });

  result.audio = filteredAudio.map((stream) => {
    const lang = (stream.tags?.language || 'und').toLowerCase();
    return {
      stream_index: stream.index,
      language: lang,
      ...determineAudioCodec(stream)
    };
  });

  result.subtitles = subtitleStreams.filter((stream) => {
    const lang = (stream.tags?.language || 'und').toLowerCase();
    const codec = stream.codec_name.toLowerCase();
    return (['en', 'eng', 'und'].includes(lang) && /subrip|hdmv_pgs_subtitle|substation/i.test(codec));
  }).map((stream) => ({
    stream_index: stream.index,
    codec: 'copy'
  }));

  return result;
}

function getCrfForResolution (width) {
  if (width >= 3840) return 28;
  if (width >= 1920) return 30;
  if (width >= 1280) return 32;
  return 34;
}

function getRateControl (width) {
  let maxrate;
  if (width >= 3840) maxrate = '10M';
  else if (width >= 1920) maxrate = '6M';
  else if (width >= 1280) maxrate = '4M';
  else maxrate = '2M';

  const maxrateValue = parseInt(maxrate, 10);
  const bufsize = `${maxrateValue * 3}M`;

  return { maxrate, bufsize };
}

function determinePreset (isUHD, fileSizeGB) {
  return (isUHD || fileSizeGB > 10) ? 7 : 6;
}

function determineAudioCodec (stream) {
  const codec = stream.codec_name.toLowerCase();
  const channels = parseInt(stream.channels || 2, 10);

  if (['aac', 'ac3', 'eac3'].includes(codec)) {
    return { codec: 'copy' };
  }

  if (channels <= 2) {
    return { codec: 'libfdk_aac', bitrate: `${(96000 * channels) / 1000}k`, channels };
  }

  return { codec: 'eac3', bitrate: `${(128000 * channels) / 1000}k`, channels };
}

/**
 * Dynamically calculates GOP size (group of pictures interval).
 * Target is 2 seconds worth of frames.
 * @param {Object} stream - The video stream.
 * @returns {number} - GOP size in frames.
 */
function calculateGOP (stream) {
  const fpsStr = stream.avg_frame_rate || stream.r_frame_rate;
  const [num, den] = fpsStr.split('/').map((n) => parseInt(n, 10));
  if (!den || Number.isNaN(num)) return 48; // fallback default
  return Math.round((num / den) * 2); // 2-second GOP
}
