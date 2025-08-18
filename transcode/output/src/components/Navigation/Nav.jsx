import React from 'react';
import PropTypes from 'prop-types';
import md5 from 'crypto-js/md5';
import './Nav.scss';
import { time_remaining } from '../../time_functions';

export default function Nav ({ data, setDataSelection, dataSelection, availableCompute }) {
  function display_file_name (file) {
    return file.split('/').pop();
  }

  function filename_hash (file) {
    return md5(file);
  }

  return (
    <>
      <h4>
        {data.length}
        {' '}
        Running jobs
        {' '}
        - Available Compute:
        {' '}
        {availableCompute}
      </h4>
      <nav>

        <ul>
          {data.map((item, index) => (
            <li key={filename_hash(item.file)}>
              <button type="button" className={dataSelection === index && 'active'} onClick={() => setDataSelection(index)}>
                {item.indexerData?.poster && (<div className="poster"><img src={item.indexerData.poster} alt={item.indexerData.title} /></div>)}
                <div>
                  {item.indexerData?.title || display_file_name(item.path)}
                  {' '}
                  <strong>
                    (
                    {Math.round(item.percent)}
                    %)
                  </strong>
                  <div>
                    {time_remaining(item.est_completed_timestamp).formatted}
                    {' '}
                    {item.name && `- ${item.name}`}
                  </div>
                  <div><em>{item.action}</em></div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

Nav.propTypes = {
  data: PropTypes.object.isRequired,
  setDataSelection: PropTypes.func.isRequired,
  dataSelection: PropTypes.number.isRequired,
  availableCompute: PropTypes.number.isRequired
};
