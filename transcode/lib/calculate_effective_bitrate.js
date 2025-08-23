/**
 * Compute a robust "effective bitrate" for a media file from ffprobe JSON.
 *
 * This function tries to give you a realistic number for decision making
 * (e.g., "should I transcode this before playback?").
 *
 * It works like this:
 * 1. Prefer stream-level data (video bitrate + sum of audio bitrates).
 * 2. Fall back to container-level bitrate or size/duration math.
 * 3. Estimate missing audio bitrates by codec/channel layout.
 * 4. Apply a headroom multiplier to account for bursty VBR, 4K, or high-FPS.
 * 5. Return a single number: estimated peak bitrate in bits per second (bps).
 *
 * @param {object} probe - ffprobe JSON output from:
 *   `ffprobe -v error -print_format json -show_format -show_streams input.mkv`
 * @param {object} [opts] - Optional tuning parameters.
 * @param {number} [opts.nicLimit=100e6] - Playback NIC limit in bps (default = 100 Mbps).
 * @param {number} [opts.safeHeadroom=1.25] - Headroom multiplier for VBR bursts.
 * @param {number} [opts.uplift4K=0.10] - Extra headroom for 4K content.
 * @returns {number} Estimated "effective bitrate" (bps).
 */
export function computeEffectiveBitrate (probe, opts = {}) {
  const {
    safeHeadroom = 1.25,
    uplift4K = 0.10
  } = opts;

  // --- Utility helpers ---
  /**
   * Converts a value to a non-negative integer if possible, else returns null.
   * @param {*} v - Value to convert.
   * @returns {number|null}
   */
  function toInt (v) {
    if (v == null) return null;
    const num = Number(v);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.floor(num));
  }
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  // --- Step 1: Try to derive container-level average bitrate ---
  const duration = toInt(probe?.format?.duration) || (probe?.format?.duration ? +probe.format.duration : null);
  const sizeBytes = toInt(probe?.format?.size);
  const formatBitrate = toInt(probe?.format?.bit_rate);

  let containerAvg = null;

  if (duration && sizeBytes) {
    // If both size and duration are known, compute average bitrate directly.
    containerAvg = (sizeBytes * 8) / duration; // bps
  } else if (formatBitrate) {
    // If no size/duration, fallback to ffprobe’s reported format.bit_rate.
    containerAvg = formatBitrate;
  }

  // --- Step 2: Collect stream info ---
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const vStream = streams.find((s) => s.codec_type === 'video');
  const aStreams = streams.filter((s) => s.codec_type === 'audio');

  // --- Step 3: Estimate audio bitrate(s) ---
  const estAudioStreams = aStreams.map((s) => {
    const br = toInt(s.bit_rate);
    if (br) return br; // use explicit value if present

    // If missing, make an educated guess based on codec + channels
    const codec = (s.codec_name || '').toLowerCase();
    const ch = toInt(s.channels) || 2;
    const sr = toInt(s.sample_rate) || 48000;
    const bps = toInt(s.bits_per_sample);

    if (codec.includes('aac')) return (ch >= 6) ? 448000 : 192000;
    if (codec === 'ac3') return (ch >= 6) ? 640000 : 384000;
    if (codec === 'eac3') return (ch >= 6) ? 896000 : 448000;
    if (codec.startsWith('truehd')) return (ch >= 8) ? 8000000 : 4500000;
    if (codec.startsWith('dts')) return (ch >= 6) ? 3000000 : 1509000;
    if (codec.startsWith('pcm')) {
      // PCM bitrate = sample_rate * bits_per_sample * channels
      const bits = bps || (codec.includes('24') ? 24 : 16);
      return sr * bits * ch;
    }

    return 192000; // conservative default guess
  });

  const estAudio = sum(estAudioStreams);

  // --- Step 4: Estimate video bitrate ---
  let videoBR = null;
  if (vStream?.bit_rate) {
    // Prefer stream-level bitrate if available
    videoBR = toInt(vStream.bit_rate);
  } else if (containerAvg) {
    // Otherwise: estimate video as containerAvg - audio - overhead
    const overhead = 1_000_000; // ~1 Mbps to account for subs/container overhead
    videoBR = Math.max(0, containerAvg - estAudio - overhead);
  }

  // --- Step 5: Pick best total average ---
  const candidates = [
    containerAvg || 0,
    (videoBR != null ? (videoBR + estAudio) : 0),
    formatBitrate || 0
  ].filter(Boolean);

  const estTotalAvg = candidates.length ? Math.max(...candidates) : 0;

  // --- Step 6: Apply headroom multipliers for peak estimate ---
  let headroom = safeHeadroom;

  // Boost headroom if video is 4K
  const width = toInt(vStream?.width);
  const height = toInt(vStream?.height);
  const is4K = (width >= 3840 || height >= 2160);

  // Parse average frame rate string (e.g., "24000/1001")
  const avgFps = (() => {
    const afr = (vStream?.avg_frame_rate || '').trim();
    if (!afr || afr === '0/0') return null;
    if (afr.includes('/')) {
      const [n, d] = afr.split('/').map(Number);
      return (d && d !== 0) ? (n / d) : null;
    }
    return Number.isFinite(+afr) ? +afr : null;
  })();

  if (is4K) headroom *= (1 + uplift4K); // add ~10% headroom for 4K
  if (avgFps && avgFps > 30) headroom *= 1.05; // add ~5% for high FPS

  // Final adjusted peak bitrate
  const estPeak = estTotalAvg * headroom;

  // --- Step 7: Return singular bitrate (rounded integer) ---
  return Math.round(estPeak);
}
