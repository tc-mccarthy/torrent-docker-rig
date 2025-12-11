/**
 * Generates transcoding instructions for video, audio, and subtitles based on ffprobe and metadata.
 *
 * This function analyzes the input media file and determines the optimal transcoding strategy for Plex/streaming:
 *
 * Video:
 *   - If the file is small (<= 1GB) and already HEVC, the video stream is copied directly to save time and resources.
 *   - Otherwise, the video is transcoded to AV1 using SVT-AV1, with HDR metadata preserved if present, and rate control parameters set for Plex compatibility.
 *
 * Audio:
 *   - Only includes streams matching the spoken languages (from TMDb/TVDb metadata).
 *   - Drops AC3 5.1 compatibility tracks if a higher-channel EAC3/TrueHD/DTS exists for the same language.
 *   - Copies AAC/AC3/EAC3 streams; otherwise, encodes stereo/mono to AAC and multichannel to EAC3.
 *
 * Subtitles:
 *   - Only includes English/undetermined streams in supported formats (SRT, PGS, ASS).
 *   - For PGS subtitles, requires valid width and height properties.
 *
 * @param {Object} mongoDoc MongoDB document containing ffprobe and metadata info.
 * @param {Object} mongoDoc.probe ffprobe output containing streams and format.
 * @param {Array<string>} [mongoDoc.audio_language] List of spoken language codes (lowercase).
 * @returns {Object} Transcoding instruction object for video, audio, and subtitles.
 * @returns {Object} return.video Video transcode instruction or null if not needed.
 * @returns {Array<Object>} return.audio List of audio transcode instructions.
 * @returns {Array<Object>} return.subtitles List of subtitle copy instructions.
 */
export function generateTranscodeInstructions (mongoDoc) {
  // Extract ffprobe and language info from the MongoDB document
  const { probe: ffprobe, audio_language = [] } = mongoDoc;

  // Defensive: ensure streams and format are always objects
  const streams = ffprobe.streams || [];
  const format = ffprobe.format || {};
  // File size in kilobytes, then convert to gigabytes for logic
  const fileSizeKB = parseInt(format.size || 0, 10);
  const fileSizeGB = fileSizeKB / 1024 ** 2;

  // Split streams by type for easier processing
  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');

  // Lowercase all spoken language codes for matching
  const spokenLangs = audio_language.map((lang) => lang.toLowerCase());

  // Prepare the result object for transcoding instructions
  const result = {
    video: null,
    audio: [],
    subtitles: []
  };

  // Main video stream is always the first video stream (assume first is main)
  // Defensive: must have a video stream
  const mainVideo = videoStreams[0];
  if (!mainVideo) throw new Error('No video stream found');

  // Gather video stream properties (codec, width, UHD status)
  const videoCodec = mainVideo.codec_name;
  const isHEVC = videoCodec === 'hevc' || videoCodec === 'h265';
  const width = mainVideo.width || 0;

  // Log the video stream being processed for debugging and traceability
  console.log(
    `Processing video stream: ${videoCodec}, width: ${width}, size: ${fileSizeGB.toFixed(2)} GB`
  );

  // If the file is small and already HEVC, just copy the video stream (saves time/resources)
  // No need to transcode, just copy the stream
  if (fileSizeGB <= 1 && isHEVC) {
    result.video = {
      stream_index: mainVideo.index,
      codec: 'copy',
      arguments: {}
    };
  } else {
    // Build AV1 transcode instruction, including HDR metadata and SVT-AV1 params
    // If HDR (PQ/2084), extract and preserve HDR mastering and content light level metadata for Plex compatibility
    const hdrProps = {};
    if (mainVideo.color_transfer?.includes('2084')) {
      hdrProps.color_primaries = mainVideo.color_primaries;
      hdrProps.color_trc = mainVideo.color_transfer;
      hdrProps.colorspace = mainVideo.color_space;

      // Extract HDR mastering and content light level metadata if present
      const sideData = mainVideo.side_data_list || [];
      const masteringDisplay = sideData.find(
        (d) => d.side_data_type === 'Mastering display metadata'
      );
      const contentLightLevel = sideData.find(
        (d) => d.side_data_type === 'Content light level metadata'
      );
      if (masteringDisplay?.mastering_display_metadata) {
        hdrProps.master_display = masteringDisplay.mastering_display_metadata;
      }
      if (contentLightLevel?.content_light_level_metadata) {
        hdrProps.cll = contentLightLevel.content_light_level_metadata;
      }
    }

    // Calculate GOP size for Plex compatibility (5s interval)
    const gop = calculateGOP(mainVideo);
    const { crf, preset } = pickCrfPresetAndFgs(mongoDoc);

    // SVT-AV1 encoder parameters for perceptual quality and compatibility
    // Includes scene-cut detection, film grain synthesis, AQ, and quant matrices
    const svtParams = [
      'fast-decode=1', // Enable fast decode for better compatibility
      'scd=1', // Scene cut detection
      'usage=0', // VOD mode
      'tier=0', // Main tier
      // 'film-grain=${fgs}', // Film grain synthesis (currently not used)
      'film-grain-denoise=0', // No denoise
      'aq-mode=1', // Adaptive quantization
      'enable-qm=1' // Enable quantization matrices
    ].join(':');

    // Build the video transcode instruction for AV1
    result.video = {
      stream_index: mainVideo.index,
      codec: 'libsvtav1',
      arguments: {
        pix_fmt: 'yuv420p10le', // 10-bit for best quality
        max_muxing_queue_size: 99999, // Avoid muxing errors
        'svtav1-params': svtParams, // SVT-AV1 encoder params
        avoid_negative_ts: 'make_zero', // Fix negative timestamps
        g: gop, // GOP size (keyframe interval)
        keyint_min: gop / 4, // Minimum keyframe interval
        preset, // Encoder preset
        crf, // Quality target
        ...getRateControl(width), // Bitrate and bufsize (optional)
        ...hdrProps // HDR metadata if present
      }
    };
  }

  // Filter and map audio streams to encoding instructions
  // - Only include streams with a language in the spokenLangs list
  // - Drop AC3 5.1 compatibility tracks if a higher channel EAC3/TrueHD/DTS exists for the same language
  // - Map each stream to its encoding parameters
  result.audio = audioStreams
    .filter((s) => {
      // Only include streams with a language in the spokenLangs list
      const lang = (s.tags?.language || 'und').toLowerCase();
      return spokenLangs.includes(lang);
    })
    .filter((stream, idx, arr) => {
      // Drop AC3 5.1 compatibility tracks if a higher channel EAC3/TrueHD/DTS exists for same language
      const lang = (stream.tags?.language || 'und').toLowerCase();
      const codec = (stream.codec_name || '').toLowerCase();
      const channels = parseInt(stream.channels || 2, 10);
      // If this is an AC3 5.1 track, check if a higher channel EAC3/TrueHD/DTS exists for same language
      if (codec === 'ac3' && channels === 6) {
        return !arr.some((other) => {
          if (other === stream) return false;
          const otherLang = (other.tags?.language || 'und').toLowerCase();
          const otherCodec = (other.codec_name || '').toLowerCase();
          const otherChannels = parseInt(other.channels || 2, 10);
          // Accept if same language and higher channel count and is EAC3/TrueHD/DTS
          return (
            otherLang === lang &&
            otherChannels > channels &&
            /eac3|truehd|dts/i.test(otherCodec)
          );
        });
      }
      return true;
    })
    .map((stream) => {
      // Map filtered audio streams to encoding instructions
      const lang = (stream.tags?.language || 'und').toLowerCase();
      // Determine codec and encoding parameters for each audio stream
      return {
        stream_index: stream.index,
        language: lang,
        ...determineAudioCodec(stream)
      };
    });

  // Filter and map subtitle streams to supported formats
  // - Only include English/und subtitle streams in supported formats (SRT, PGS, ASS)
  // - For PGS, require width and height > 0
  result.subtitles = subtitleStreams
    .filter((stream) => {
      const lang = (stream.tags?.language || 'und').toLowerCase();
      const codec = stream.codec_name?.toLowerCase();
      // Only keep English/und and supported subtitle codecs
      if (!['en', 'eng', 'und'].includes(lang)) return false;
      if (/subrip|substation/i.test(codec)) return true;
      if (codec === 'hdmv_pgs_subtitle') {
        // Require valid width and height > 0 for PGS
        const w = Number(stream.width || 0);
        const h = Number(stream.height || 0);
        return w > 0 && h > 0;
      }
      return false;
    })
    .map((stream) => ({
      stream_index: stream.index,
      codec: 'copy'
    }));

  // Return the full transcoding instruction object
  return result;
}

/**
 * Picks CRF (Constant Rate Factor), FGS (Film Grain Synthesis), and encoder preset values
 * based on video resolution and genres.
 *
 * This function uses a rule map to select encoding parameters for AV1 based on the width of the video
 * and whether the content is animation or action. The first matching rule is used.
 *
 * @param {Object} mongoDoc ffprobe + indexerData doc
 * @param {Object} mongoDoc.probe ffprobe output
 * @param {Object} [mongoDoc.indexerData] Indexer metadata (genres)
 * @returns {{crf:number, fgs:number, preset:number}} Encoding parameters for AV1
 */
export function pickCrfPresetAndFgs (mongoDoc) {
  const width = Number(
    mongoDoc?.probe?.streams?.find((s) => s.codec_type === 'video')?.width || 0
  );
  const genres = (mongoDoc?.indexerData?.genres || []).map((g) =>
    g.toLowerCase());

  const isAnimation = genres.some((g) => /anim/.test(g));
  const isAction = genres.some((g) => /action|adventure|war|sci[- ]?fi/.test(g));

  /**
   * Rule map: first match wins.
   * width = minimum width threshold
   */
  const rules = [
  // --- UHD (3840x2160) ---
    { width: 3840, isAnimation: false, isAction: false, crf: 27, fgs: 2, preset: 8 }, // General: retain detail, modest grain
    { width: 3840, isAnimation: true, isAction: false, crf: 26, fgs: 0, preset: 9 }, // Animation: clean visuals, no grain
    { width: 3840, isAnimation: false, isAction: true, crf: 27, fgs: 3, preset: 8 }, // Action: balance texture and bitrate

    // --- 1080p (1920x1080) ---
    { width: 1920, isAnimation: false, isAction: false, crf: 27, fgs: 2, preset: 8 }, // General: avoid artifacting, maintain texture
    { width: 1920, isAnimation: true, isAction: false, crf: 26, fgs: 0, preset: 9 }, // Animation: crisp, clean
    { width: 1920, isAnimation: false, isAction: true, crf: 27, fgs: 2, preset: 8 }, // Action: fgs=2 enough for depth without blur

    // --- 720p (1280x720) ---
    { width: 1280, isAnimation: false, isAction: false, crf: 27, fgs: 1, preset: 8 }, // Lower res, low grain to preserve clarity
    { width: 1280, isAnimation: true, isAction: false, crf: 26, fgs: 0, preset: 9 } // Animation at 720p: skip grain, maintain sharpness
  ];

  // First rule that fits resolution + genres
  let match = rules.find(
    (r) =>
      width >= r.width &&
      r.isAnimation === isAnimation &&
      r.isAction === isAction
  );

  // if there's no match, use defaults
  if (!match) {
    match = { width: 0, isAnimation: false, isAction: false, crf: 27, fgs: 2, preset: 8 };
  }

  // Default fallback if nothing matches
  return match;
}

/**
 * Returns maxrate and bufsize for ffmpeg rate control based on video width.
 * Used to ensure reasonable streaming bitrates for different resolutions.
 *
 * @param {number} width Video width in pixels
 * @returns {{maxrate: string, bufsize: string}} Rate control parameters for ffmpeg
 */
function getRateControl (width) {
  let maxrate;

  if (width >= 3840) {
    // 4K UHD — try to stay under 20M to allow 1–2 concurrent streams
    maxrate = '24M';
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
 * Maps a channel count to a valid ffmpeg channel layout string for audio encoding.
 *
 * @param {number} channels Number of audio channels
 * @returns {string} Channel layout name for ffmpeg filter
 */
function mapAudioFilter (channels) {
  // Mapping of channel count to ffmpeg channel layout names
  const map = {
    1: 'pan=stereo|c0=c0|c1=c0', // OK for both
    2: '', // OK for both
    3: 'channelmap=channel_layout=stereo', // Fallback (2.1 isn't valid)
    4: 'channelmap=channel_layout=quad', // Supported by EAC3; rarely used in AAC
    5: 'channelmap=channel_layout=5.0',
    6: 'channelmap=channel_layout=5.1'
  };

  return map[channels];
}

/**
 * Determines the audio codec and encoding parameters for a given stream.
 *
 * - If input is AAC, AC3, or EAC3, copies the stream.
 * - For stereo/mono, uses AAC at 96k per channel (mixed to stereo).
 * - For multichannel, uses EAC3 at 128k per channel (max 768k).
 *
 * @param {Object} stream ffprobe audio stream object
 * @returns {Object} Audio encoding parameters for ffmpeg
 */
function determineAudioCodec (stream) {
  const codec = stream.codec_name.toLowerCase();
  // Limit to 6 channels max due to EAC3 limitations (surround audio)
  const channels = Math.min(parseInt(stream.channels || 2, 10), 6);

  // If already a supported codec, just copy (no need to re-encode)
  if (['aac', 'ac3', 'eac3'].includes(codec)) {
    return { codec: 'copy' };
  }

  // Use aac for mono/stereo (best quality for Plex)
  if (channels <= 2) {
    return {
      codec: 'aac', // always use aac for mono/stereo
      bitrate: `${(96000 * channels) / 1000}k`, // 96k per channel
      channels: 2, // always mix to stereo -- mono gets mixed to stereo
      filter: mapAudioFilter(channels)
    };
  }

  // Use EAC3 for multichannel (surround audio)
  return {
    codec: 'eac3',
    bitrate: `${Math.min(128000 * channels, 768000) / 1000}k`,
    channels,
    filter: mapAudioFilter(channels)
  };
}

/**
 * Calculates GOP size (group of pictures interval) for Plex compatibility.
 *
 * Target is 5 seconds worth of frames, or fallback to 120 frames if unknown.
 *
 * @param {Object} stream Video stream object
 * @returns {number} GOP size in frames
 */
function calculateGOP (stream) {
  // Use avg_frame_rate if available, else r_frame_rate
  const fpsStr = stream.avg_frame_rate || stream.r_frame_rate;
  const [num, den] = fpsStr.split('/').map((n) => parseInt(n, 10));
  if (!den || Number.isNaN(num)) return 120; // fallback default (24fps * 5s)
  // Calculate GOP as 5 seconds worth of frames (for longer keyframe interval)
  return Math.round((num / den) * 5);
}
