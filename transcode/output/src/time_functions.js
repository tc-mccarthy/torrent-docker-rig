import dayjs from './dayjs';

export function formatSecondsToHHMMSS (totalSeconds) {
  if (Number.isNaN(totalSeconds)) return 'calculating';

  const total = Math.ceil(Number(totalSeconds)); // round up
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const pad = (n) => String(n).padStart(2, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function time_remaining (timestamp) {
  const now = Date.now();
  const diff = timestamp - now;

  if (diff <= 0) {
    return { formatted: 'Calculating...', datetime: '-' };
  }

  const seconds = Math.floor(diff / 1000);
  return {
    formatted: formatSecondsToHHMMSS(seconds),
    datetime: estimated_local_time(seconds)
  };
}

export function elapsed (timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  return formatSecondsToHHMMSS(seconds);
}

export function estimated_local_time (seconds) {
  const final_time = dayjs().add(seconds, 'seconds');
  let fmt_string = 'MM/DD/YYYY HH:mm:ss';

  if (final_time.isSame(dayjs(), 'day')) {
    fmt_string = 'HH:mm:ss';
  }
  return final_time.format(fmt_string);
}
