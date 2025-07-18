/**
 * Generates transcoding instructions based on ffprobe and metadata (TMDb/TVDb) in a mongo document.
 * Optimizes for Plex compatibility, preserves commentary and HDR, and dynamically tunes CRF, bitrate, and GOP.
 *
 * @param {Object} mongoDoc - Mongo document containing `probe` (ffprobe output) and `audio_language` metadata.
 * @returns {Object} Transcoding instruction object with video, audio, and subtitle stream instructions.
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

  // Group streams by type
  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');

  const spokenLangs = audio_language.map((lang) => lang.toLowerCase());

  const result = {
    video: null,
    audio: [],
    subtitles: []
  };

  // === VIDEO INSTRUCTIONS ===
  const mainVideo = videoStreams[0];
  if (!mainVideo) throw new Error('No video stream found');

  const videoCodec = mainVideo.codec_name;
  const isHEVC = videoCodec === 'hevc' || videoCodec === 'h265';
  const width = mainVideo.width || 0;

  console.log(`Processing video stream: ${videoCodec}, width: ${width}, size: ${fileSizeGB.toFixed(2)} GB`);

  if (fileSizeGB <= 1 && isHEVC) {
    // If file is small and HEVC, just copy the video stream
    result.video = {
      stream_index: mainVideo.index,
      codec: 'copy',
      arguments: {}
    };
  } else {
    // Preserve HDR properties if present
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

    // Dynamically determine GOP (keyframe) interval from framerate (target: 2s GOP)
    const avgFpsStr = mainVideo.avg_frame_rate || '24/1';
    const [num, den] = avgFpsStr.split('/').map(Number);
    const fps = den ? num / den : 24;
    const gopInterval = Math.round(fps * 2);

    // Build AV1 encoding arguments with dynamic quality and bitrate tuning
    result.video = {
      stream_index: mainVideo.index,
      codec: 'libsvtav1',
      arguments: {
        preset: 7, // Speed/quality tradeoff
        crf: getOptimalCrf(width), // Quality tuned for resolution
        tune: 0, // Default tune setting
        usage: 0, // VOD mode (lower latency)
        tier: 0, // Low decode complexity for Plex
        ...getRateControl(width), // maxrate + bufsize tailored to resolution
        max_muxing_queue_size: 9999, // Avoid muxer buffer overflows
        pix_fmt: 'yuv420p10le', // AV1 HDR-safe pixel format
        keyint_min: gopInterval,
        g: gopInterval,
        sc_threshold: 0, // Disable scene-based keyframes
        avoid_negative_ts: 'make_zero', // Ensure timestamps are zero-based
        ...hdrProps // Preserve HDR10+ metadata if available
      }
    };
  }

  // === AUDIO INSTRUCTIONS ===
  const filteredAudio = audioStreams
    .filter((s) => {
      const lang = (s.tags?.language || 'und').toLowerCase();
      return spokenLangs.includes(lang);
    })
    .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0)); // Keep higher bitrate streams first

  result.audio = filteredAudio.map((stream) => {
    const lang = (stream.tags?.language || 'und').toLowerCase();
    const channels = parseInt(stream.channels || 2, 10);
    const codec = stream.codec_name.toLowerCase();
    const canCopy = ['aac', 'ac3', 'eac3'].includes(codec);

    const instruction = {
      stream_index: stream.index,
      language: lang,
      codec: 'copy'
    };

    // Re-encode if codec is not copy-safe
    if (!canCopy) {
      if (channels <= 2) {
        instruction.codec = 'libfdk_aac';
        instruction.bitrate = `${96 * channels}k`;
      } else {
        instruction.codec = 'eac3';
        instruction.bitrate = `${128 * channels}k`;
      }
    }

    return instruction;
  });

  // === SUBTITLE INSTRUCTIONS ===
  result.subtitles = subtitleStreams
    .filter((stream) => {
      const lang = (stream.tags?.language || 'und').toLowerCase();
      const codec = stream.codec_name.toLowerCase();
      return ['en', 'eng', 'und'].includes(lang) && /subrip|hdmv_pgs_subtitle|substation/i.test(codec);
    })
    .map((stream) => ({
      stream_index: stream.index,
      codec: 'copy'
    }));

  return result;
}

/**
 * Returns an optimal CRF value based on video resolution width.
 * Higher CRF = more compression, lower quality (but smaller files).
 *
 * @param {number} width - Video width in pixels.
 * @returns {number} CRF value
 */
function getOptimalCrf (width) {
  if (width >= 3840) {
    return 28; // UHD / 4K
  } if (width >= 1920) {
    return 30; // Full HD
  } if (width >= 1280) {
    return 32; // HD 720p
  }
  return 34; // SD and below
}

/**
 * Returns recommended maxrate and bufsize for AV1 encoding based on video resolution.
 * Bufsize is always 3x the maxrate for smoother bitrate control.
 *
 * @param {number} width - Video width in pixels.
 * @returns {Object} - { maxrate: string, bufsize: string }
 */
function getRateControl (width) {
  let maxrateMbps;

  if (width >= 3840) {
    maxrateMbps = 12;
  } else if (width >= 1920) {
    maxrateMbps = 10;
  } else if (width >= 1280) {
    maxrateMbps = 6;
  } else {
    maxrateMbps = 4;
  }

  return {
    maxrate: `${maxrateMbps}M`,
    bufsize: `${maxrateMbps * 3}M`
  };
}
