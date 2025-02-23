import React, { useState } from 'react';
import './Home.scss';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import dayjs from '../../dayjs';
import LinearProgressWithLabel from '../LinearProgressWithLabel/LinearProgressWithLabel';
// import CircularProgressWithLabel from '../CircularProgressWithLabel/CircularProgressWithLabel';
import Nav from '../Navigation/Nav';

async function getData (setData, setFileList, setDisks, setUtilization, setStatus) {
  try {
    clearTimeout(window.dataTimeout);
    const d = await fetch('active.json').then((r) => r.json());

    setData(d);

    const f = await fetch('filelist.json').then((r) => r.json());

    setFileList(f);

    const disks = await fetch('disk.json').then((r) => r.json());

    setDisks(disks);

    const utilization = await fetch('utilization.json').then((r) => r.json());

    setUtilization(utilization);

    const status = await fetch('status.json').then((r) => r.json());

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
  const [filelist, setFileList] = useState([]);
  const [disks, setDisks] = useState(false);
  const [utilization, setUtilization] = useState(false);
  const [status, setStatus] = useState(false);
  const [dataSelection, setDataSelection] = useState(0);

  const mvp = [dataSource, filelist, disks, utilization, status].filter((d) => !d);

  // interface waits for all data to be loaded
  if (mvp.length > 0) {
    getData(setData, setFileList, setDisks, setUtilization, setStatus);
    return (
      <Box sx={{ display: 'flex' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (dataSource.length === 0) {
    return (
      <Box sx={{ display: 'flex' }}>
        <CircularProgress />
      </Box>
    );
  }

  const data = dataSource[dataSelection];

  return (
    <div className="container image">
      <div className="overline" />
      <h1>Optimized video encoding</h1>
      <Nav data={dataSource} dataSelection={dataSelection} setDataSelection={setDataSelection} />
      <div className="widget center">
        <strong>{data.file}</strong>
        {' '}
        (
        {data.video_stream.codec_name}
        /
        {data.audio_streams[0].codec_name}
        )
      </div>
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
          {data.audio_streams.map((stream) => stream.tags?.language).join(', ')}
        </div>
      </div>
      <div className="flex">
        <div className="widget">
          <strong>Expected completed time</strong>
          {estimated_local_time(data.output.est_completed_seconds)}
        </div>
        <div className="widget">
          <strong>ETA</strong>
          {data.output.time_remaining}
        </div>
      </div>
      <div className="flex">
        <div className="widget">
          <strong>Files Remaining</strong>
          {status.unprocessed_files.toLocaleString()}
          {/* <CircularProgressWithLabel numerator={numerator} denominator={denominator} /> */}
        </div>
        <div className="widget">
          <strong>File Progress</strong>
          <LinearProgressWithLabel value={data.output.percent} />
        </div>
      </div>
      <div className="flex">
        <div className="widget">
          <strong>Library Coverage</strong>
          <LinearProgressWithLabel value={Math.round(status.library_coverage)} />
        </div>
      </div>

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

      <div className="widget center">
        <strong>Command</strong>
        {data.ffmpeg_cmd}
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
                <th>Path</th>
                <th>Size</th>
                <th>Resolution</th>
                <th>Codec</th>
                <th>Encode version</th>
              </tr>
              {filelist.map((f, idx) => (
                <tr>
                  <td>{idx + 1}</td>
                  <td>{f.priority}</td>
                  <td>{f.path}</td>
                  <td>{make_human_readable(f.size)}</td>
                  <td>{f.resolution}</td>
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
