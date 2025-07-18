import React, { useState } from 'react';
import './Home.scss';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import dayjs from '../../dayjs';
import LinearProgressWithLabel from '../LinearProgressWithLabel/LinearProgressWithLabel';
// import CircularProgressWithLabel from '../CircularProgressWithLabel/CircularProgressWithLabel';
import Nav from '../Navigation/Nav';

export function formatSecondsToHHMMSS (totalSeconds) {
  if (Number.isNaN(totalSeconds)) return 'calculating';

  const total = Math.ceil(Number(totalSeconds)); // round up
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const pad = (n) => String(n).padStart(2, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Converts a number of bytes into a human-readable string with appropriate units.
 *
 * @param {number} bytes - The number of bytes to format.
 * @param {number} decimals - Number of decimal places to include (default is 2).
 * @returns {string} A string representing the human-readable format (e.g., "1.23 MB").
 */
function formatBytes (bytes, decimals = 2) {
  // If the input is 0, return immediately
  if (bytes === 0) return '0 Bytes';

  const k = 1024; // Base value for kilobyte (using binary convention)
  const dm = decimals < 0 ? 0 : decimals; // Ensure decimals is not negative
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']; // Unit suffixes

  /**
   * Determine the index of the appropriate unit (KB, MB, GB, etc.)
   *
   * Explanation:
   * - Math.log(bytes) gives the logarithm (base e) of the byte value.
   * - Math.log(k) gives the logarithm of 1024.
   * - Dividing log(bytes) by log(1024) is equivalent to taking log base 1024 of bytes.
   *   This tells us how many times the value can be divided by 1024 before falling below 1.
   * - Math.floor() ensures we get the largest whole number index,
   *   which corresponds to the unit size just below the actual value.
   */
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  // Divide the byte value by the appropriate power of 1024 to get the converted size
  const size = bytes / k ** i;

  // Round to the desired number of decimal places and append the unit label
  return `${parseFloat(size.toFixed(dm))} ${sizes[i]}`;
}

function fetchData (src, cache_buster = true) {
  try {
    const timestamp = Date.now();
    let url = src;

    if (cache_buster) {
      url += `?t=${timestamp}`;
    }

    return fetch(url).then((r) => r.json());
  } catch (e) {
    console.error('Error fetching data:', e);
    throw e;
  }
}

async function getData (setData, setFileList, setDisks, setUtilization, setStatus, setAvailableCompute) {
  try {
    clearTimeout(window.dataTimeout);
    const d = await fetchData('active.json');

    setData(d.active);
    setAvailableCompute(d.availableCompute);

    const f = await fetchData('filelist.json');

    setFileList(f);

    const disks = await fetchData('disk.json');

    setDisks(disks);

    const utilization = await fetchData('utilization.json');

    setUtilization(utilization);

    const status = await fetchData('status.json');

    setStatus(status);

    window.dataTimeout = setTimeout(() => {
      getData(...arguments);
    }, 1 * 1000);
  } catch (e) {
    window.dataTimeout = setTimeout(() => {
      getData(...arguments);
    }, 1 * 1000);
  }
}

function estimated_local_time (seconds) {
  const final_time = dayjs().add(seconds, 'seconds');
  let fmt_string = 'MM/DD/YYYY HH:mm:ss';

  if (final_time.isSame(dayjs(), 'day')) {
    fmt_string = 'HH:mm:ss';
  }
  return final_time.format(fmt_string);
}

function human_size (size) {
  const order = ['gb', 'mb', 'kb'];
  const output_size = order.find((o) => size[o] >= 1);
  const rounded_size = Math.round(size[output_size] * 100) / 100;

  return rounded_size + output_size;
}

function make_human_readable (size) {
  let calc_size = +size;
  const units = ['kb', 'mb', 'gb'];
  let unit = 0;

  while (calc_size > 1024) {
    calc_size /= 1024;
    unit += 1;
  }

  return `${Math.round(calc_size * 100) / 100}${units[unit]}`;
}

function Home () {
  const [dataSource, setData] = useState(false);
  const [availableCompute, setAvailableCompute] = useState(false);
  const [filelist, setFileList] = useState([]);
  const [disks, setDisks] = useState(false);
  const [utilization, setUtilization] = useState(false);
  const [status, setStatus] = useState(false);
  const [dataSelection, setDataSelection] = useState(0);

  const mvp = [dataSource, filelist, disks, utilization, status].filter((d) => !d);

  // interface waits for all data to be loaded
  if (mvp.length > 0) {
    getData(setData, setFileList, setDisks, setUtilization, setStatus, setAvailableCompute);
    return (
      <div className="container image">
        <div className="overline" />
        <h1>BitForge</h1>
        <em>AV1 at full throttle—without burning the rig.</em>
        <div className="loader">
          <Box sx={{ display: 'flex' }}>
            <CircularProgress />
          </Box>
        </div>
      </div>
    );
  }

  // if (dataSource.length === 0) {
  //   return (
  //     <Box sx={{ display: 'flex' }}>
  //       <CircularProgress />
  //     </Box>
  //   );
  // }

  const data = dataSource[dataSelection];

  return (
    <div className="container image">
      <div className="overline" />
      <h1>BitForge</h1>
      <em>AV1 at full throttle—without burning the rig.</em>
      {dataSource && dataSource.length > 0 && <Nav data={dataSource} availableCompute={availableCompute} dataSelection={dataSelection} setDataSelection={setDataSelection} />}
      {data && (
        <div className="widget center">
          <strong>{data.file}</strong>
          {' '}
          (
          {data.source_video_codec}
          /
          {data.source_audio_codec}
          )
        </div>
      )}
      {data && (
        <div className="flex">
          {data && (
            <div className="widget">
              <strong>File Progress</strong>
              <LinearProgressWithLabel value={data.output.percent} />
            </div>
          )}
        </div>
      )}
      {data && (
        <div className="flex">
          <div className="widget">
            <strong>Elapsed</strong>
            {data.output.run_time}
          </div>
          <div className="widget">
            <strong>Timecode</strong>
            {data.output.timemark}
          </div>
          <div className="widget">
            <strong>Profile</strong>
            {data.name}
          </div>
          <div className="widget">
            <strong>Audio Languages</strong>
            {data.audio_languages.join(', ')}
          </div>
        </div>
      )}
      {data && (
        <div className="flex">
          <div className="widget">
            <strong>FPS</strong>
            {data.output.currentFps}
          </div>
          <div className="widget">
            <strong>Kbps</strong>
            {data.output.currentKbps}
          </div>
          <div className="widget">
            <strong>ETA</strong>
            {data.output.time_remaining}
            <em>
              (
              {estimated_local_time(data.output.est_completed_seconds)}
              )
            </em>
          </div>
        </div>
      )}
      {data && (
        <div className="flex">
          <div className="widget">
            <strong>Compute Score</strong>
            {data.output.computeScore}
          </div>
          <div className="widget">
            <strong>Priority</strong>
            {data.output.priority}
          </div>
        </div>
      )}

      {data && (
        <div className="flex">
          <div className="widget">
            <strong>Original Size</strong>
            {human_size(data.output.size.original)}
          </div>
          <div className="widget">
            <strong>Current Size</strong>
            {human_size(data.output.size.progress)}
          </div>
          <div className="widget">
            <strong>Est. Final Size</strong>
            <em>
              {`${
              Math.round(+data.output.size.estimated_final.change.replace('%', '') * 100) / 100
            }%`}
            </em>
            {human_size(data.output.size.estimated_final)}
          </div>
        </div>
      )}

      {data && (
        <div className="widget center">
          <strong>Command</strong>
          {data.ffmpeg_cmd}
        </div>
      )}

      <div className="flex">
        <div className="widget">
          <strong>CPU</strong>
          <LinearProgressWithLabel value={utilization.cpu} />
        </div>
        <div className="widget">
          <strong>Memory</strong>
          <LinearProgressWithLabel value={utilization.memory} />
        </div>
      </div>
      <div className="flex">
        <div className="widget">
          <strong>Files Remaining</strong>
          {status.unprocessed_files.toLocaleString()}
        </div>
        <div className="widget">
          <strong>Files Processed this session</strong>
          {status.processed_files_delta.toLocaleString()}
        </div>
        <div className="widget">
          <strong>Files Processed all time</strong>
          {status.processed_files.toLocaleString()}
        </div>
      </div>
      <div className="flex">
        <div className="widget">
          <strong>Service Uptime</strong>
          {formatSecondsToHHMMSS(Math.floor((Date.now() - status.serviceStartTime) / 1000))}
        </div>
        <div className="widget">
          <strong>Reclaimed Space</strong>
          {formatBytes(status.reclaimedSpace)}
        </div>
        <div className="widget">
          <strong>Library Coverage</strong>
          <LinearProgressWithLabel value={Math.round(status.library_coverage)} />
        </div>
      </div>

      <div className="flex quarter disks">
        {!disks?.map && <div className="widget center">Loading...</div>}
        {disks?.map &&
          disks?.map((disk) => (
            <div className={['widget', disk.above_threshold && 'danger'].filter((c) => c).join(' ')}>
              <strong>{disk.mounted}</strong>
              <em>{[disk.used, 'of', disk.size].join(' ')}</em>
              <LinearProgressWithLabel value={disk.percent_used} className={[disk.above_threshold && 'danger'].filter((c) => c).join(' ')} />
            </div>
          ))}
      </div>

      <div className="widget list">
        {!filelist?.data?.map && <em>Loading...</em>}
        <strong>
          Next
          {' '}
          {filelist?.data?.length.toLocaleString()}
          {' '}
          queued files
          {' '}
          <em>
            (Updated:
            {' '}
            {filelist?.refreshed}
            )
          </em>
        </strong>
        <div className="overflow">
          {filelist?.data?.map && (
            <table>
              <tr>
                <th>#</th>
                <th>Priority</th>
                <th>File</th>
                <th>Storage Volume</th>
                <th>Size</th>
                <th>Resolution</th>
                <th>Compute Score</th>
                <th>Codec</th>
                <th>Encode version</th>
              </tr>
              {filelist?.data?.map((f, idx) => (
                <tr>
                  <td>{idx + 1}</td>
                  <td>{f.priority}</td>
                  <td>{f.path}</td>
                  <td>{f.volume}</td>
                  <td>{make_human_readable(f.size)}</td>
                  <td>{f.resolution}</td>
                  <td>{f.computeScore}</td>
                  <td>{f.codec}</td>
                  <td>{f.encode_version}</td>
                </tr>
              ))}
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default Home;
