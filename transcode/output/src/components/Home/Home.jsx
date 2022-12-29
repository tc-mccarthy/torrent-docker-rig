import React, { useState } from 'react';
import './Home.scss';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import LinearProgressWithLabel from '../LinearProgressWithLabel/LinearProgressWithLabel';

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

  return (
    <div className="container">
      <h1>Optimized video encoding</h1>
      <div>
        <strong>{data.file}</strong>
        {' '}
        {data.overall_progress}
      </div>
      <div>
        {data.output.timemark}
        {' '}
        |
        {' '}
        {data.name}
      </div>
      <LinearProgressWithLabel value={data.output.percent} />
      <div className="flex">
        <div>
          <strong>Elapsed:</strong>
          {' '}
          {data.output.run_time}
        </div>
        <div>
          <strong>ETA:</strong>
          {' '}
          {data.output.time_remaining}
        </div>
      </div>
      <div className="flex">
        <div>
          <strong>Original Size:</strong>
          {' '}
          {human_size(data.output.size.original)}
        </div>
        <div>
          <strong>Progress:</strong>
          {' '}
          {human_size(data.output.size.progress)}
        </div>
        <div>
          <strong>Estimated Final Size:</strong>
          {' '}
          {human_size(data.output.size.estimated_final)}
          {' '}
          (
          {`${Math.round(+data.output.size.estimated_final.change.replace('%', '') * 100) / 100}%`}
          )
        </div>
      </div>
    </div>
  );
}

export default Home;
