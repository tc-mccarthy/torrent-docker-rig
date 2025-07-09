import React, { useState } from 'react';
import './Home.scss';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import dayjs from '../../dayjs';
import LinearProgressWithLabel from '../LinearProgressWithLabel/LinearProgressWithLabel';
// import CircularProgressWithLabel from '../CircularProgressWithLabel/CircularProgressWithLabel';
import Nav from '../Navigation/Nav';

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
      <Box sx={{ display: 'flex' }}>
        <CircularProgress />
      </Box>
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
      <h1>Optimized video encoding</h1>
      {dataSource && dataSource.length > 0 && <Nav data={dataSource} availableCompute={availableCompute} dataSelection={dataSelection} setDataSelection={setDataSelection} />}
      {data && (
        <div className="widget center">
          <strong>{data.file}</strong>
          {' '}
          (
          {data.video_stream.codec_name}
          /
          {data.audio_streams[0].codec_name}
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
            {data.audio_streams.map((stream) => stream.tags?.language).reduce((a, c) => {
              if (!a.includes(c)) {
                a.push(c);
              }
              return a;
            }, []).join(', ')}
          </div>
        </div>
      )}
      {data && (
        <div className="flex">
          <div className="widget">
            <strong>ETA</strong>
            {data.output.time_remaining}
            <em>
              (
              {estimated_local_time(data.output.est_completed_seconds)}
              )
            </em>
          </div>
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
        <div className="widget">
          <strong>Up time</strong>
          {status.service_up_time}
        </div>
      </div>
      <div className="flex">
        <div className="widget">
          <strong>Library coverage</strong>
          {status.library_coverage.toLocaleString()}
          %
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
        {!filelist?.map && <em>Loading...</em>}
        <strong>
          Next
          {' '}
          {filelist.length.toLocaleString()}
          {' '}
          queued files
        </strong>
        <div className="overflow">
          {filelist?.map && (
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
              {filelist.map((f, idx) => (
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
