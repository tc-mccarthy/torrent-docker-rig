// transcodeInstructions.js

/**
 * Generates transcoding instructions based on ffprobe and metadata (TMDb/TVDb) in a mongo document.
 * @param {Object} mongoDoc - The Mongo document containing ffprobe and metadata info.
 * @returns {Object} - Transcoding instruction object.
 */
export function generateTranscodeInstructions (mongoDoc) {
  const {
    probe: ffprobe,
    audio_language = []
  } = mongoDoc;

  const streams = ffprobe.streams || [];
  const format = ffprobe.format || {};
  const fileSizeBytes = parseInt(format.size || 0, 10);
  const fileSizeGB = fileSizeBytes / (1024 ** 3);

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

  // If <=1GB and HEVC, copy it; otherwise re-encode to SVT-AV1
  if (fileSizeGB <= 1 && isHEVC) {
    result.video = {
      stream_index: mainVideo.index,
      codec: 'copy'
    };
  } else {
    result.video = {
      stream_index: mainVideo.index,
      codec: 'libsvtav1',
      profile: 7,
      crf: isUHD ? 28 : 30
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
    const channels = parseInt(stream.channels || 2, 10);
    const codec = stream.codec_name.toLowerCase();
    const canCopy = ['aac', 'ac3', 'eac3'].includes(codec);

    const instruction = {
      stream_index: stream.index,
      language: lang,
      codec: 'copy'
    };

    if (!canCopy) {
      if (channels <= 2) {
        instruction.codec = 'libfdk_aac';
        instruction.bitrate = 96000 * channels;
      } else {
        instruction.codec = 'eac3';
        instruction.bitrate = 128000 * channels;
      }
    }

    return instruction;
  });

  // === SUBTITLE INSTRUCTIONS ===
  result.subtitles = subtitleStreams.filter((stream) => {
    const lang = (stream.tags?.language || 'und').toLowerCase();
    const codec = stream.codec_name.toLowerCase();

    return (['en', 'eng', 'und'].includes(lang) && ['subrip', 'pgs', 'ass'].includes(codec));
  }).map((stream) => ({
    stream_index: stream.index,
    codec: 'copy'
  }));

  return result;
}
