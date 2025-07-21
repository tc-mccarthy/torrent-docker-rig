import roundComputeScore from './round-compute-score';

export default function calculateComputeScore (job) {
  // Extract the first video stream from ffprobe data
  const video = job.probe?.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('No video stream found in probe data');

  // 1. Base score from resolution (relative to full 4K)
  const areaScore = (video.width * video.height) / (3840 * 2160);

  // 2. Bit depth factor: more bits per pixel = more memory per frame
  const bitDepth = parseInt(
    video.bits_per_raw_sample || video.bits_per_sample || '8',
    10
  );
  const bitDepthFactor = bitDepth > 8 ? 1.2 : 1;

  // 3. Pixel format: 4:2:2 or 4:4:4 subsampling increases memory
  const pixFmt = video.pix_fmt || '';
  const chromaFactor = (() => {
    if (pixFmt.includes('422')) return 1.1;
    if (pixFmt.includes('444')) return 1.3;
    return 1; // assume 4:2:0 (default)
  })();

  // 4. Audio stream multiplier: each extra audio track adds 5%
  const audioStreams = this.probe?.streams?.filter((s) => s.codec_type === 'audio') || [];
  const extraAudioCount = Math.max(audioStreams.length - 1, 0);
  const audioFactor = 1 + extraAudioCount * 0.05;

  // 5. Container complexity multiplier: more than 10 streams = 10% bump
  const streamCount = this.probe?.streams?.length || 1;
  const containerFactor = streamCount > 10 ? 1.1 : 1;

  // Final compute score focused purely on memory pressure
  const rawScore = areaScore * bitDepthFactor * chromaFactor * audioFactor * containerFactor;

  return roundComputeScore(rawScore);
}
