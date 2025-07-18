import React from 'react';
import PropTypes from 'prop-types';
import md5 from 'crypto-js/md5';
import './Nav.scss';

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
                {display_file_name(item.file)}
                {' '}
                <strong>
                  (
                  {Math.round(item.percent)}
                  %)
                </strong>
                <div>
                  {item.time_remaining}
                  {' '}
                  {item.name && `- ${item.name}`}
                </div>
                <div><em>{item.action}</em></div>
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
