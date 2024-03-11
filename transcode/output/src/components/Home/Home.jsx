import React, { useState } from 'react';
import './Home.scss';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import moment from 'moment';
import LinearProgressWithLabel from '../LinearProgressWithLabel/LinearProgressWithLabel';
// import CircularProgressWithLabel from '../CircularProgressWithLabel/CircularProgressWithLabel';

async function getData (setData, setFileList, setDisks, setUtilization) {
  try {
    const d = await fetch('active.json').then((r) => r.json());

    setData(d);

    const f = await fetch('filelist.json').then((r) => r.json());

    setFileList(f);

    const disks = await fetch('disk.json').then((r) => r.json());

    setDisks(disks);

    const utilization = await fetch('utilization.json').then((r) => r.json());

    setUtilization(utilization);

    setTimeout(() => {
      getData(setData, setFileList, setDisks, setUtilization);
    }, 1 * 1000);
  } catch (e) {
    setTimeout(() => {
      getData(setData, setFileList);
    }, 1 * 1000);
  }
}

function estimated_local_time (seconds) {
  const final_time = moment().add(seconds, 'seconds');
  let fmt_string = 'MM/DD/YYYY HH:mm:ss';

  if (final_time.isSame(moment(), 'day')) {
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

function Home () {
  const [data, setData] = useState(false);
  const [filelist, setFileList] = useState(false);
  const [disks, setDisks] = useState(false);
  const [utilization, setUtilization] = useState(false);

  if (!data) {
    getData(setData, setFileList, setDisks, setUtilization);
    return (
      <Box sx={{ display: 'flex' }}>
        <CircularProgress />
      </Box>
    );
  }

  const [numerator, denominator] = data.overall_progress.replace(/[()]/g, '').split('/');
  const files_remaining = denominator - numerator;
  return (
    <div className="container image">
      <div className="overline" />
      <h1>Optimized video encoding</h1>
      <div className="widget center">
        <strong>{data.file}</strong>
        {' '}
        (
        {data.video_stream.codec_name}
        /
        {data.audio_stream.codec_name}
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
          {files_remaining.toLocaleString()}
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
          <LinearProgressWithLabel value={Math.round(utilization.library_coverage)} />
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

      <div className="flex quarter">
        {!disks?.map && <div className="widget center">Loading...</div>}
        {disks?.map &&
          disks?.map((disk) => (
            <div className="widget">
              <strong>{disk.mounted}</strong>
              <em>{[disk.used, 'of', disk.size].join(' ')}</em>
              <LinearProgressWithLabel value={parseFloat(disk.use.replace('%', ''))} />
            </div>
          ))}
      </div>

      <div className="widget list">
        <strong>Remaining files</strong>
        {!filelist?.map && <em>Loading...</em>}
        {filelist?.map && (
          <ol>
            {filelist.map((f) => (
              <li>{f}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export default Home;
