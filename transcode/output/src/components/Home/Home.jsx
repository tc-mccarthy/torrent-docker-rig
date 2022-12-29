import React, { useState } from 'react';
import './Home.scss';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import LinearProgressWithLabel from '../LinearProgressWithLabel/LinearProgressWithLabel';
import CircularProgressWithLabel from '../CircularProgressWithLabel/CircularProgressWithLabel';

async function getData (setData) {
  const d = await fetch('active.json').then((r) => r.json());

  setData(d);

  setTimeout(() => {
    getData(setData);
  }, 2.5 * 1000);
}

function human_size (size) {
  const order = ['gb', 'mb', 'kb'];
  const output_size = order.find((o) => size[o] >= 1);
  const rounded_size = Math.round(size[output_size] * 100) / 100;

  return rounded_size + output_size;
}

function Home () {
  const [data, setData] = useState(false);

  if (!data) {
    getData(setData);
    return (
      <Box sx={{ display: 'flex' }}>
        <CircularProgress />
      </Box>
    );
  }

  const [numerator, denominator] = data.overall_progress.replace(/[()]/g, '').split('/');

  return (
    <div className="container image">
      <div className="overline" />
      <h1>Optimized video encoding</h1>
      <div className="widget center">
        <strong>{data.file}</strong>
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
          <strong>ETA</strong>
          {data.output.time_remaining}
        </div>
      </div>
      <div className="widget center">
        <LinearProgressWithLabel value={data.output.percent} />
        <div className="circle">
          <CircularProgressWithLabel numerator={numerator} denominator={denominator} />
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
          <em>{`${Math.round(+data.output.size.estimated_final.change.replace('%', '') * 100) / 100}%`}</em>
          {human_size(data.output.size.estimated_final)}
        </div>
        <div className="widget">
          <strong>ETA</strong>
          {data.output.time_remaining}
        </div>
      </div>

      <div className="widget center">
        <strong>Command</strong>
        {data.ffmpeg_cmd}
      </div>

    </div>
  );
}

export default Home;
