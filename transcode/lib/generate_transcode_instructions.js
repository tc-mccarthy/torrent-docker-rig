/**
 * Generates transcoding instructions based on ffprobe and metadata (TMDb/TVDb) in a mongo document.
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

  // Final result object
  const result = {
    video: null,
    audio: [],
    subtitles: []
  };

  // === VIDEO INSTRUCTION ===
  const mainVideo = videoStreams[0];
  if (!mainVideo) throw new Error('No video stream found');

  const videoCodec = mainVideo.codec_name;
  const isHEVC = videoCodec === 'hevc' || videoCodec === 'h265';
  const width = mainVideo.width || 0;
  const isUHD = width >= 3840;

  console.log(`Processing video stream: ${videoCodec}, width: ${width}, size: ${fileSizeGB.toFixed(2)} GB`);

  // If <=1GB and HEVC, copy the stream directly; otherwise re-encode to SVT-AV1
  if (fileSizeGB <= 1 && isHEVC) {
    result.video = {
      stream_index: mainVideo.index,
      codec: 'copy',
      arguments: {}
    };
  } else {
    // HDR properties (if present) for preserving Dolby Vision or HDR10+ info
    const hdrProps = {};
    if (mainVideo.color_transfer?.includes('2084')) {
      // Color properties for HDR
      hdrProps.color_primaries = mainVideo.color_primaries;
      hdrProps.color_trc = mainVideo.color_transfer;
      hdrProps.colorspace = mainVideo.color_space;

      // Optional mastering display metadata
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
        preset: determinePreset(isUHD, fileSizeGB),
        crf: getCrfForResolution(width),
        ...getRateControl(width),
        ...hdrProps // Spread HDR properties if available
      }
    };
  }

  // === AUDIO INSTRUCTIONS ===
  const filteredAudio = audioStreams
    .filter((s) => {
      const lang = (s.tags?.language || 'und').toLowerCase();
      return spokenLangs.includes(lang);
    })
    .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0)); // Sort by bitrate descending

  result.audio = filteredAudio.map((stream) => {
    const lang = (stream.tags?.language || 'und').toLowerCase();
    return {
      stream_index: stream.index,
      language: lang,
      ...determineAudioCodec(stream)
    };
  });

  // === SUBTITLE INSTRUCTIONS ===
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

/**
 * Chooses the best CRF based on resolution.
 * @param {number} width - The width of the video.
 * @returns {number} - Appropriate CRF value.
 */
function getCrfForResolution (width) {
  if (width >= 3840) return 28; // UHD
  if (width >= 1920) return 30; // HD
  if (width >= 1280) return 32; // 720p
  return 34; // SD
}

/**
 * Chooses maxrate and bufsize based on resolution.
 * @param {number} width - The width of the video.
 * @returns {{ maxrate: string, bufsize: string }} - Rate control settings.
 */
function getRateControl (width) {
  let maxrate;
  if (width >= 3840) maxrate = '10M';
  else if (width >= 1920) maxrate = '6M';
  else if (width >= 1280) maxrate = '4M';
  else maxrate = '2M';

  const maxrateValue = parseInt(maxrate, 10); // value in M
  const bufsize = `${maxrateValue * 3}M`;

  return { maxrate, bufsize };
}

/**
 * Determines the optimal SVT-AV1 preset for a given file.
 * @param {boolean} isUHD - Whether the video is UHD resolution.
 * @param {number} fileSizeGB - The file size in gigabytes.
 * @returns {number} - The encoder preset to use (lower is slower).
 */
function determinePreset (isUHD, fileSizeGB) {
  return (isUHD || fileSizeGB > 10) ? 7 : 6;
}

/**
 * Determines appropriate audio codec and bitrate based on input stream.
 * @param {Object} stream - An audio stream object from ffprobe.
 * @returns {{ codec: string, bitrate?: string }} - Audio encoding settings.
 */
function determineAudioCodec (stream) {
  const codec = stream.codec_name.toLowerCase();
  const channels = parseInt(stream.channels || 2, 10);

  if (['aac', 'ac3', 'eac3'].includes(codec)) {
    return { codec: 'copy' };
  }

  if (channels <= 2) {
    return { codec: 'libfdk_aac', bitrate: `${(96000 * channels) / 1000}k` };
  }

  return { codec: 'eac3', bitrate: `${(128000 * channels) / 1000}k` };
}
