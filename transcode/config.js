import base_config from "./base-config.js";

const transcode_config = {
  ...base_config,
  sources: [
    {
      path: "/source_media/Drax/Movies",
      scratch: "/source_media/Drax/transcode_scratch",
    },
    {
      path: "/source_media/Drax/Disney",
      scratch: "/source_media/Drax/transcode_scratch",
    },
    {
      path: "/source_media/Danvers/TV Shows",
      scratch: "/source_media/Danvers/transcode_scratch",
    },
    {
      path: "/source_media/Wanda/TV Shows",
      scratch: "/source_media/Wanda/transcode_scratch",
    },
    {
      path: "/source_media/Drax/Random",
      scratch: "/source_media/Drax/transcode_scratch",
    },
  ],
};

export default transcode_config;
