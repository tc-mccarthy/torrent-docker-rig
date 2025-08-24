/**
 * @file generate_transcode_instructions.js
 * @module generateTranscodeInstructions
 *
 * Generates high-quality, Plex-friendly transcoding instructions for video, audio, and subtitles.
 * - Video: SVT-AV1 with perceptual tuning, adaptive film grain, HDR/SDR signaling, and robust mux args.
 * - Audio: Retains all English tracks and preferred languages, drops AC3 5.1 if better exists, encodes stereo to AAC and multichannel to EAC3.
 * - Subtitles: Copies English/und and any forced streams in supported formats.
 *
 * Expects a MongoDB document with ffprobe-like data:
 *   {
 *     format: { ... },
 *     streams: [ ... ],
 *     library_prefs: { audio_language: ['en'], ... },
 *     analysis: { noise_profile: 0..1, edge_density: 0..1 }
 *   }
 */

/**
 * @typedef {Object} FFprobeStream
 * @property {string} codec_name
 * @property {string} codec_type - "video" | "audio" | "subtitle"
 * @property {number|string} width
 * @property {number|string} height
 * @property {string} r_frame_rate
 * @property {string} avg_frame_rate
 * @property {number|string} channels
 * @property {Object} tags
 * @property {Object} disposition
 */

/**
 * @typedef {Object} TranscodeInstruction
 * @property {Object|null} video - Video transcode/copy instruction
 * @property {Array<Object>} audio - Audio stream instructions
 * @property {Array<Object>} subtitles - Subtitle stream instructions
 */

/**
 * Generates transcoding instructions for a media file based on ffprobe and user preferences.
 *
 * @param {Object} mongoDoc - Document with ffprobe results and preferences.
 * @returns {TranscodeInstruction} - Instructions for video, audio, and subtitles.
 */
export function generateTranscodeInstructions (mongoDoc) {
  const { streams = [], format = {}, library_prefs = {} } = mongoDoc || {};
  const videoStream = streams.find((s) => s.codec_type === 'video');
  if (!videoStream) {
    return { video: null, audio: [], subtitles: [] };
  }

  // ---------- Preferences & helpers ----------
  const audio_language = Array.isArray(library_prefs.audio_language) && library_prefs.audio_language.length
    ? library_prefs.audio_language
    : ['en']; // default

  // Lowercase language list for matching; always keep English tracks
  const spokenLangs = audio_language.map((l) => String(l).toLowerCase());

  const width = Number(videoStream.width || 0);
  const height = Number(videoStream.height || 0);

  // ---------- Decide copy vs transcode for video ----------
  const isHevc = /^(hevc|h265)$/i.test(videoStream.codec_name || '');
  const canCopyHevc = shouldCopyHevc(format, videoStream);
  const isHdrInput = isHdr(videoStream);

  // Video instruction result placeholder
  let videoInstruction = null;

  if (isHevc && canCopyHevc) {
    // Copy video if small and already HEVC
    videoInstruction = {
      codec: 'copy',
      map: getStreamSpecifier(videoStream),
      // Mux safety: avoid negative timestamps, variable framerate, timescale
      mux: {
        avoid_negative_ts: 'make_zero',
        vsync: 'vfr',
        video_track_timescale: 90000
      }
    };
  } else {
    // Transcode to AV1 (SVT-AV1)

    // Calculate longer GOP (~8–10s) with scene-cut detection for Plex compatibility
    const base2sGop = calculate2sGOP(videoStream); // ~2s GOP
    const longGop = Math.max(Math.round(base2sGop * 4), 120); // ~8s+, min 120 frames
    const keyintMin = Math.max(Math.round(longGop / 4), 24);

    // Pure CRF, tuned by resolution and content type
    const crf = pickCrfByResolution(width) + getContentCrfBump(mongoDoc);

    // Adaptive film-grain level based on content analysis
    const filmGrainLevel = pickFilmGrainLevel(mongoDoc);

    // SVT-AV1 encoder params: perceptual tuning, AQ, quant matrices, film grain
    const svtParams = [
      'usage=0',
      'tier=0',
      'scd=1',
      'aq-mode=1',
      'enable-qm=1',
      `film-grain=${filmGrainLevel}`,
      'film-grain-denoise=0'
    ].join(':');

    // Signal HDR/SDR metadata
    const colorSignals = getColorSignals(videoStream, isHdrInput);

    // Mux safety arguments
    const muxArgs = {
      avoid_negative_ts: 'make_zero',
      vsync: 'vfr',
      video_track_timescale: 90000
    };

    // Preset selection for batch/non-UHD
    const preset = determinePreset({ width, height, forBatch: true });

    videoInstruction = {
      codec: 'libsvtav1',
      map: getStreamSpecifier(videoStream),
      pix_fmt: 'yuv420p10le', // 10-bit for best quality, reduces banding
      crf,
      // No VBV caps for offline/archival quality; add maxrate/bufsize if needed
      g: longGop,
      keyint_min: keyintMin,
      encoder_params: svtParams,
      preset,
      ...colorSignals,
      mux: muxArgs
    };
  }

  // Build audio encoding/copy plan
  const audioInstructions = buildAudioPlan(streams, spokenLangs);

  // Subtitle selection: keep English/und and any forced (any language) in supported formats
  const subtitleInstructions = streams
    .filter((s) => s.codec_type === 'subtitle')
    .filter((s) => {
      const lang = (s.tags?.language || 'und').toLowerCase();
      const isEnglishLike = /^(en|eng|und)$/.test(lang);
      const isForced = s.disposition?.forced === 1;
      const isSupportedCodec = /subrip|hdmv_pgs_subtitle|substation/i.test(s.codec_name || '');
      return (isEnglishLike || isForced) && isSupportedCodec;
    })
    .map((s) => ({
      codec: 'copy',
      map: getStreamSpecifier(s)
    }));

  return {
    video: videoInstruction,
    audio: audioInstructions,
    subtitles: subtitleInstructions
  };
}

// ======================= Helper Functions =======================

/**
 * Calculates a classic 2-second GOP from stream FPS.
 * @param {FFprobeStream} stream - Video stream object
 * @returns {number} - GOP size in frames
 */
function calculate2sGOP (stream) {
  const fps = getFps(stream) || 24;
  return Math.round(fps * 2); // 2 seconds
}

/**
 * Extracts frames-per-second as a float from stream metadata.
 * @param {FFprobeStream} stream - Video stream object
 * @returns {number} - FPS value
 */
function getFps (stream) {
  const fpsStr = stream?.avg_frame_rate || stream?.r_frame_rate || '0/1';
  const [n, d] = String(fpsStr).split('/').map((v) => Number(v));
  if (!n || !d) return 0;
  return n / d;
}

/**
 * Determines if HEVC video should be copied instead of transcoded.
 * Heuristic: copy if input is HEVC and container size/bitrate is small enough.
 * @param {Object} format - Format metadata
 * @param {FFprobeStream} videoStream - Video stream object
 * @returns {boolean} - True if copy is preferred
 */
function shouldCopyHevc (format, videoStream) {
  const size = Number(format?.size || 0);
  const bitrate = Number(format?.bit_rate || 0);
  // Example heuristics (tweak to your library priorities):
  // - small files (<2.5 GiB) OR moderate bitrate (<4 Mbps) for 1080p-and-below
  const is1080OrLess = Number(videoStream.width || 0) <= 1920 && Number(videoStream.height || 0) <= 1080;
  const smallSize = size > 0 && size < 2.5 * 1024 * 1024 * 1024;
  const moderateBitrate = bitrate > 0 && bitrate < 4_000_000;
  return is1080OrLess && (smallSize || moderateBitrate);
}

/**
 * Determines if input is HDR-like based on transfer/primaries.
 * @param {FFprobeStream} vs - Video stream object
 * @returns {boolean} - True if HDR detected
 */
function isHdr (vs) {
  const trc = (vs.color_transfer || vs.color_trc || '').toLowerCase();
  const prim = (vs.color_primaries || '').toLowerCase();
  return /2084|hlg/.test(trc) || /bt2020/.test(prim);
}

/**
 * Computes CRF by resolution. Lower CRF = higher quality.
 * @param {number} w - Video width in pixels
 * @returns {number} - CRF value
 */
function pickCrfByResolution (w) {
  if (w >= 3840) return 30; // 4K/UHD
  if (w >= 2560) return 29; // QHD/1440p
  if (w >= 1920) return 28; // 1080p
  if (w >= 1280) return 27; // 720p
  return 26; // SD and below
}

/**
 * Returns a content-aware CRF bump for animation/noisy film.
 * Negative numbers tighten quality; positive numbers relax it.
 * @param {Object} doc - Full mongoDoc for context
 * @returns {number} - CRF adjustment
 */
function getContentCrfBump (doc) {
  const title = (doc?.format?.tags?.title || doc?.streams?.[0]?.tags?.title || '').toLowerCase();
  const isAnime = /anime|animated|pixar|ghibli|dreamworks|illumination/.test(title);
  if (isAnime) return -2;

  const n = Number(doc?.analysis?.noise_profile ?? doc?.noise_profile ?? 0);
  if (n > 0.45) return +1;

  return 0;
}

/**
 * Picks adaptive AV1 film-grain synthesis level based on content.
 * @param {Object} doc - Full mongoDoc for context
 * @returns {number} - Film grain level (0..50)
 */
function pickFilmGrainLevel (doc) {
  const title = (doc?.format?.tags?.title || doc?.streams?.[0]?.tags?.title || '').toLowerCase();
  const isAnime = /anime|animated|pixar|ghibli|dreamworks|illumination/.test(title);
  if (isAnime) return 2;

  // prefer analysis.noise_profile if available (0..1)
  const n = Number(doc?.analysis?.noise_profile ?? doc?.noise_profile ?? 0);
  if (n > 0.45) return 12; // naturally grainy scan
  if (n > 0.25) return 9; // moderate grain
  return 7; // clean(ish) SDR
}

/**
 * Ensures full color/HDR signaling is present, with safe defaults.
 * @param {FFprobeStream} vs - Video stream object
 * @param {boolean} isHdrInput - True if HDR detected
 * @returns {Object} - Key/value pairs for video instruction
 */
function getColorSignals (vs, isHdrInput) {
  if (isHdrInput) {
    return {
      color_range: 'tv',
      color_primaries: vs.color_primaries || 'bt2020',
      color_trc: vs.color_transfer || vs.color_trc || 'smpte2084',
      colorspace: vs.colorspace || 'bt2020nc'
    };
  }
  // SDR defaults
  return {
    color_range: 'tv',
    color_primaries: vs.color_primaries || 'bt709',
    color_trc: vs.color_transfer || vs.color_trc || 'bt709',
    colorspace: vs.colorspace || 'bt709'
  };
}

/**
 * Decides SVT-AV1 preset for throughput/quality balance.
 * - For large non-UHD batches, preset 7 is preferred.
 * - Otherwise, preset 6 for balanced throughput/quality.
 * @param {{width:number,height:number,forBatch?:boolean}} opts - Video dimensions and batch flag
 * @returns {number} - SVT-AV1 preset value
 */
function determinePreset ({ width, height, forBatch = false }) {
  const isUhd = width >= 3840 || height >= 2160;
  if (!isUhd && forBatch) return 7;
  return 6;
}

/**
 * Builds audio encoding/copy plan for all streams.
 * - Drops AC3 5.1 when a higher-channel EAC3/TrueHD/DTS exists for the same language.
 * - Copies AAC/AC3/EAC3 when suitable; otherwise stereo→AAC, multichannel→EAC3.
 * - Keeps all English audio (commentaries etc.) regardless of user preference.
 * @param {FFprobeStream[]} streams - All media streams
 * @param {string[]} spokenLangsLower - Preferred languages (lowercased)
 * @returns {Array<Object>} - Audio instructions
 */
function buildAudioPlan (streams, spokenLangsLower) {
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');

  // Pre-index by language for the "drop AC3 5.1 when better exists" rule
  const byLang = audioStreams.reduce((map, s) => {
    const lang = (s.tags?.language || 'und').toLowerCase();
    if (!map.has(lang)) map.set(lang, []);
    map.get(lang).push(s);
    return map;
  }, new Map());

  /**
   * Returns true if an AC3 stream should be dropped because a higher-channel better codec exists for the same language.
   * @param {FFprobeStream} s - Audio stream
   * @returns {boolean}
   */
  function dropAc3IfBetterExists (s) {
    const lang = (s.tags?.language || 'und').toLowerCase();
    if (!/ac3/i.test(s.codec_name || '')) return false;
    const list = byLang.get(lang) || [];
    const ch = Number(s.channels || 2);
    return list.some((other) => {
      if (other === s) return false;
      const betterCodec = /eac3|truehd|dts/i.test(other.codec_name || '');
      const higherCh = Number(other.channels || 2) > ch;
      return betterCodec && higherCh;
    });
  }

  return audioStreams.reduce((result, s) => {
    const lang = (s.tags?.language || 'und').toLowerCase();
    const channels = Number(s.channels || 2);
    const codec = String(s.codec_name || '');

    // Keep all English tracks and preferred languages
    const isEnglish = /^(en|eng)$/.test(lang);
    const isPreferred = spokenLangsLower.includes(lang) || isEnglish;

    let shouldInclude = true;

    if (!isPreferred) {
      // Non-preferred language: only keep if explicitly commentary
      const title = (s.tags?.title || '').toLowerCase();
      const isCommentary = /commentary|director|behind[-\s]?the[-\s]?scenes/.test(title);
      if (!isCommentary) shouldInclude = false;
    }

    // Drop AC3 5.1 when better exists for same language
    if (shouldInclude && dropAc3IfBetterExists(s)) shouldInclude = false;

    if (shouldInclude) {
      // Copy AAC/AC3/EAC3, otherwise encode
      if (/^(aac|ac3|eac3)$/i.test(codec)) {
        result.push({ codec: 'copy', map: getStreamSpecifier(s) });
      } else if (channels <= 2) {
        result.push({
          codec: 'aac',
          bitrate: 192000,
          map: getStreamSpecifier(s)
        });
      } else {
        const per2ch = 160_000;
        const target = Math.min(Math.ceil((channels / 2) * per2ch), 896_000);
        result.push({
          codec: 'eac3',
          bitrate: target,
          map: getStreamSpecifier(s)
        });
      }
    }
    return result;
  }, []);
}

/**
 * Builds a safe stream specifier string like "0:3" based on index, or falls back to type-based specifier.
 * @param {FFprobeStream} s - Media stream object
 * @returns {string} - Stream specifier for ffmpeg
 */
function getStreamSpecifier (s) {
  if (typeof s.index === 'number') return `0:${s.index}`;
  // Fallback: map by type, first occurrence
  if (s.codec_type === 'video') return 'v:0';
  if (s.codec_type === 'audio') return 'a:0';
  if (s.codec_type === 'subtitle') return 's:0';
  return '0:0';
}
