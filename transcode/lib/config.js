import base_config from './base-config';
import packageInfo from '../package.json';

const transcode_config = {
  ...base_config,
  application_version: packageInfo.version,
  sources: [
    {
      path: '/source_media/Drax/Movies',
      scratch: '/source_media/Drax/transcode_scratch'
    },
    {
      path: '/source_media/Rogers/Movies',
      scratch: '/source_media/Rogers/transcode_scratch'
    },
    {
      path: '/source_media/Drax/Disney',
      scratch: '/source_media/Drax/transcode_scratch'
    },
    {
      path: '/source_media/Danvers/TV Shows',
      scratch: '/source_media/Danvers/transcode_scratch'
    },
    {
      path: '/source_media/Wanda/TV Shows',
      scratch: '/source_media/Wanda/transcode_scratch'
    },
    {
      path: '/source_media/Drax/Random',
      scratch: '/source_media/Drax/transcode_scratch'
    },
    {
      path: '/source_media/Stark/TV Shows',
      scratch: '/source_media/Stark/transcode_scratch'
    },
    {
      path: '/source_media/Parker/TV Shows',
      scratch: '/source_media/Parker/transcode_scratch'
    }
  ]
};

export default transcode_config;
