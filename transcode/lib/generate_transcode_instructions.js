/**
 * Generates transcoding instructions based on ffprobe and metadata (TMDb/TVDb) in a mongo document.
 *
 * This function analyzes video, audio, and subtitle streams and determines whether to copy or transcode
 * based on stream characteristics (e.g., codec, size, resolution, HDR metadata). This version includes:
 * - Dynamic GOP size calculation for improved Plex compatibility
 * - Usage of `-avoid_negative_ts make_zero` to fix negative timestamps
 * - SVT-AV1 `usage`, `tier`, and `fast-decode` passed via `-svtav1-params`
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
/**
 * Generates transcoding instructions based on ffprobe and metadata (TMDb/TVDb) in a mongo document.
 *
 * This function analyzes video, audio, and subtitle streams and determines whether to copy or transcode
 * based on stream characteristics (e.g., codec, size, resolution, HDR metadata). This version includes:
 * - Dynamic GOP size calculation for improved Plex compatibility
 * - Usage of `-avoid_negative_ts make_zero` to fix negative timestamps
 * - SVT-AV1 `usage`, `tier`, and `fast-decode` passed via `-svtav1-params`
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
  // Extract ffprobe and language info from the document
  const {
    probe: ffprobe,
    audio_language = []
  } = mongoDoc;

  // Defensive: ensure streams and format are always objects
  const streams = ffprobe.streams || [];
  const format = ffprobe.format || {};
  // File size in kilobytes, then convert to gigabytes for logic
  const fileSizeKB = parseInt(format.size || 0, 10);
  const fileSizeGB = fileSizeKB / (1024 ** 2);

  // Split streams by type for easier processing
  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');

  // Lowercase all spoken language codes for matching
  const spokenLangs = audio_language.map((lang) => lang.toLowerCase());

  // Prepare the result object
  const result = {
    video: null,
    audio: [],
    subtitles: []
  };

  // Main video stream is always the first video stream
  const mainVideo = videoStreams[0];
  if (!mainVideo) throw new Error('No video stream found');

  // Gather video stream properties
  const videoCodec = mainVideo.codec_name;
  const isHEVC = videoCodec === 'hevc' || videoCodec === 'h265';
  const width = mainVideo.width || 0;
  const isUHD = width >= 3840;

  // Log the video stream being processed for debugging
  console.log(`Processing video stream: ${videoCodec}, width: ${width}, size: ${fileSizeGB.toFixed(2)} GB`);

  // If the file is small and already HEVC, just copy the video stream
  if (fileSizeGB <= 1 && isHEVC) {
    // No need to transcode, just copy the stream
    result.video = {
      stream_index: mainVideo.index,
      codec: 'copy',
      arguments: {}
    };
  } else {
    // Otherwise, build a full transcode instruction
    const hdrProps = {};
    // If HDR (PQ/2084), preserve HDR metadata
    if (mainVideo.color_transfer?.includes('2084')) {
      // Copy HDR color primaries, transfer, and colorspace
      hdrProps.color_primaries = mainVideo.color_primaries;
      hdrProps.color_trc = mainVideo.color_transfer;
      hdrProps.colorspace = mainVideo.color_space;

      // Extract HDR mastering and content light level metadata if present
      const sideData = mainVideo.side_data_list || [];
      const masteringDisplay = sideData.find((d) => d.side_data_type === 'Mastering display metadata');
      const contentLightLevel = sideData.find((d) => d.side_data_type === 'Content light level metadata');

      if (masteringDisplay?.mastering_display_metadata) {
        hdrProps.master_display = masteringDisplay.mastering_display_metadata;
      }
      if (contentLightLevel?.content_light_level_metadata) {
        hdrProps.cll = contentLightLevel.content_light_level_metadata;
      }
    }

    // Calculate GOP size for Plex compatibility
    const gop = calculateGOP(mainVideo);

    // Build SVT-AV1 specific encoder parameters into a single string
    const svtParams = [
      'fast-decode=1',
      'scd=1',
      'usage=0',
      'tier=0'
    ].join(':');

    // Build the video transcode instruction
    result.video = {
      stream_index: mainVideo.index,
      codec: 'libsvtav1',
      arguments: {
        pix_fmt: 'yuv420p10le', // 10-bit for best quality
        max_muxing_queue_size: 9999, // Avoid muxing errors
        'svtav1-params': svtParams, // Pass SVT-AV1 params
        avoid_negative_ts: 'make_zero', // Fix negative timestamps
        g: gop, // GOP size
        keyint_min: gop / 2, // Minimum keyframe interval
        preset: determinePreset(isUHD, fileSizeGB), // Encoder preset
        crf: getCrfForResolution(width), // Quality target
        ...getRateControl(width), // Bitrate and bufsize
        ...hdrProps // HDR metadata if present
      }
    };
  }

  // Filter audio streams to only those matching spoken languages
  const filteredAudio = audioStreams
    .filter((s) => {
      // Only include streams with a language in the spokenLangs list
      const lang = (s.tags?.language || 'und').toLowerCase();
      return spokenLangs.includes(lang);
    });

  // Map filtered audio streams to encoding instructions
  result.audio = filteredAudio.map((stream) => {
    const lang = (stream.tags?.language || 'und').toLowerCase();
    // Determine codec and encoding parameters for each audio stream
    return {
      stream_index: stream.index,
      language: lang,
      ...determineAudioCodec(stream)
    };
  });

  // Only include English/und subtitle streams in supported formats
  result.subtitles = subtitleStreams.filter((stream) => {
    const lang = (stream.tags?.language || 'und').toLowerCase();
    const codec = stream.codec_name?.toLowerCase();
    // Only keep English/und and supported subtitle codecs
    return (['en', 'eng', 'und'].includes(lang) && /subrip|hdmv_pgs_subtitle|substation/i.test(codec));
  }).map((stream) => ({
    stream_index: stream.index,
    codec: 'copy'
  }));

  // Return the full transcoding instruction object
  return result;
}

/**
 * Returns the CRF (Constant Rate Factor) value for a given video width.
 * Lower CRF means higher quality. Adjusts for UHD, 1080p, 720p, and SD.
 *
 * @param {number} width - Video width in pixels.
 * @returns {number} - CRF value for ffmpeg.
 */
function getCrfForResolution (width) {
  if (width >= 3840) return 27; // 4K UHD: 26–28 recommended
  if (width >= 1920) return 26; // 1080p: 24–26 sweet spot for action
  if (width >= 1280) return 28; // 720p
  return 30; // SD
}

/**
 * Returns the maxrate and bufsize for ffmpeg rate control based on video width.
 * Ensures reasonable streaming bitrates for different resolutions.
 *
 * @param {number} width - Video width in pixels.
 * @returns {{maxrate: string, bufsize: string}} - Rate control parameters.
 */
function getRateControl (width) {
  let maxrate;

  if (width >= 3840) {
    // 4K UHD — try to stay under 20M to allow 1–2 concurrent streams
    maxrate = '16M';
  } else if (width >= 1920) {
    // 1080p — visually solid AV1 at ~8 Mbps
    maxrate = '8M';
  } else if (width >= 1280) {
    // 720p — good at 4M, preserves detail
    maxrate = '4M';
  } else {
    // SD — very low bitrate needed
    maxrate = '2M';
  }

  // Buffer size is 2x maxrate for more stable streaming
  const numericRate = parseInt(maxrate, 10);
  const bufsize = `${numericRate * 2}M`;

  return { maxrate, bufsize };
}

/**
 * Selects the encoder preset for SVT-AV1 based on resolution and file size.
 *
 * - UHD (4K) always uses preset 8 (slowest, highest quality)
 * - Non-UHD files larger than 10GB use preset 7 (slower, higher quality)
 * - All others use preset 6 (default balance)
 *
 * @param {boolean} isUHD - True if the video is UHD/4K.
 * @param {number} fileSizeGB - File size in gigabytes.
 * @returns {number} - SVT-AV1 preset value (6, 7, or 8)
 */
function determinePreset (isUHD, fileSizeGB) {
  if (isUHD) return 8;
  if (fileSizeGB > 10) return 7;
  return 6;
}

/**
 * Maps a channel count to a valid channel layout string for audio encoding.
 *
 * @param {number} channels - Number of audio channels.
 * @returns {string} - Channel layout name.
 */
function mapChannelLayout (channels) {
  // Mapping of channel count to ffmpeg channel layout names
  const map = {
    1: 'mono', // OK for both
    2: 'stereo', // OK for both
    3: 'stereo', // Fallback (2.1 isn't valid)
    4: 'quad', // Supported by EAC3; rarely used in AAC
    5: '5.0',
    6: '5.1'
  };

  return map[channels] || 'stereo';
}

/**
 * Determines the audio codec and encoding parameters for a given stream.
 *
 * - If the input is already AAC, AC3, or EAC3, copy the stream.
 * - For stereo or mono, use libfdk_aac at 96k per channel.
 * - For multichannel, use EAC3 at 128k per channel (max 768k).
 *
 * @param {Object} stream - ffprobe audio stream object.
 * @returns {Object} - Audio encoding parameters for ffmpeg.
 */
function determineAudioCodec (stream) {
  const codec = stream.codec_name.toLowerCase();
  // Limit to 6 channels max due to EAC3 limitations
  const channels = Math.min(parseInt(stream.channels || 2, 10), 6);

  // If already a supported codec, just copy
  if (['aac', 'ac3', 'eac3'].includes(codec)) {
    return { codec: 'copy' };
  }

  // Use libfdk_aac for mono/stereo
  if (channels <= 2) {
    return { codec: 'libfdk_aac', bitrate: `${(96000 * channels) / 1000}k`, channels, channel_layout: mapChannelLayout(channels) };
  }

  // Use EAC3 for multichannel
  return { codec: 'eac3', bitrate: `${(Math.min(128000 * channels, 768000) / 1000)}k`, channels, channel_layout: mapChannelLayout(channels) };
}

/**
 * Dynamically calculates GOP size (group of pictures interval).
 * Target is 2 seconds worth of frames for optimal Plex compatibility.
 *
 * @param {Object} stream - The video stream.
 * @returns {number} - GOP size in frames.
 */
function calculateGOP (stream) {
  // Use avg_frame_rate if available, else r_frame_rate
  const fpsStr = stream.avg_frame_rate || stream.r_frame_rate;
  const [num, den] = fpsStr.split('/').map((n) => parseInt(n, 10));
  if (!den || Number.isNaN(num)) return 48; // fallback default
  // Calculate GOP as 2 seconds worth of frames
  return Math.round((num / den) * 2);
}
