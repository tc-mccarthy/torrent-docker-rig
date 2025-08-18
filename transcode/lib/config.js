
/**
 * @fileoverview Transcode configuration module.
 * Defines application version and media source directories for transcode jobs.
 * Each source includes a scratch path and a stage_path for ephemeral video staging.
 */

import base_config from './base-config';
import packageInfo from '../package.json';


/**
 * Transcode configuration object.
 *
 * @type {Object}
 * @property {string} application_version - Application version from package.json
 * @property {Array<Object>} sources - Array of media source objects
 */
const transcode_config = {
  ...base_config,
  application_version: packageInfo.version,
  /**
   * List of media sources for transcode jobs.
   * Each source includes:
   *   - path: Source directory for media files
   *   - scratch: Persistent scratch directory for transcode temp files
   *   - stage_path: Ephemeral location for staging source video during transcode
   */
  sources: [
    {
      path: '/source_media/Barton/Movies',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    },
    {
      path: '/source_media/Drax/Movies',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    },
    {
      path: '/source_media/Rogers/Movies',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    },
    {
      path: '/source_media/Drax/Disney',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    },
    {
      path: '/source_media/Danvers/TV Shows',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    },
    {
      path: '/source_media/Wanda/TV Shows',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    },
    {
      path: '/source_media/Drax/Random',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    },
    {
      path: '/source_media/Stark/TV Shows',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    },
    {
      path: '/source_media/Parker/TV Shows',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    },
    {
      path: '/source_media/Romanoff/TV Shows',
      scratch: '/source_media/transcode_scratch',
      stage_path: '/source_media/transcode_scratch'
    }
  ]
};


/**
 * Exports the transcode configuration object for use in transcode jobs and service orchestration.
 */
export default transcode_config;
