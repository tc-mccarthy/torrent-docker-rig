import { exec } from "child_process";
import async from "async";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import trash from "trash";
import moment from "moment";
import path from "path";

const PATHS = process.env.TRANSCODE_PATHS.split(/[,]\s*\//).map(
  (path) => "/" + path
);

function exec_promise(cmd) {
  return new Promise((resolve, reject) => {
    console.log("Running", cmd);
    exec(cmd, { maxBuffer: 1024 * 1024 * 500 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function pre_sanitize() {
  const findCMD = `find ${PATHS.map((p) => `"${p}"`).join(
    " "
  )} -iname ".deletedByTMM" -type d -exec rm -Rf {} \\;`;
  const { stdout, stderr } = await exec_promise(findCMD);
  console.log(stdout);
}

async function generate_filelist() {
  // Get the list of files to be converted

  const file_ext = [
    "avi",
    "mkv",
    "m4v",
    "flv",
    "mov",
    "wmv",
    "webm",
    "gif",
    "mpg",
    "mp4",
  ];
  const findCMD = `find ${PATHS.map((p) => `"${p}"`).join(" ")} \\( ${file_ext
    .map((ext) => `-iname "*.${ext}"`)
    .join(" -o ")} \\) -not \\( -iname "*.tc.mkv" \\) -print0 | sort -z`;

  const { stdout, stderr } = await exec_promise(findCMD);

  const filelist = stdout
    .split("/media")
    .filter((j) => j)
    .map((p) => `/media${p}`.replace("\x00", ""))
    .filter((f) => {
      const curr_path = path.dirname(f);
      // console.log(">> curr_path >>", curr_path);
      const lock_file_pattern = new RegExp(
        path
          .basename(f)
          .replace(/[+]/g, "[+]")
          .replace(/\.[A-Za-z0-9]+$/, ".*.tclock")
          .replace("(", "\\(")
          .replace(")", "\\)")
          .replace(/\s+/g, "\\s+"),
        "i"
      );
      let episode_code = f.match(/(S[0-9]+E[0-9]+)/);
      console.log(">> LOCK FILE PATTERN >>", lock_file_pattern);
      const files = fs.readdirSync(curr_path);
      // console.log(files);
      let lock_file = files.find((file) => lock_file_pattern.test(file));
      // console.log("LOCK FILE", lock_file);
      if (!lock_file && episode_code) {
        episode_code = new RegExp(episode_code[1] + ".*tclock$");
        lock_file = files.find((file) => episode_code.test(file));
      }
      return !lock_file;
    });

  fs.writeFileSync("./filelist.txt", filelist.join("\n"));
  return filelist;
}

function aspect_round(val) {
  return Math.round(val * 10) / 10;
}

async function ffprobe(file) {
  const ffprobeCMD = `ffprobe -v quiet -print_format json -show_format -show_chapters -show_streams "${file}"`;
  const { stdout, stderr } = await exec_promise(ffprobeCMD);

  const data = JSON.parse(stdout);

  data.format.duration = +data.format.duration;
  data.format.size = +data.format.size;
  data.format.bit_rate = +data.format.bit_rate;
  data.format.size = +data.format.size / 1024;

  const video = data.streams.find((s) => s.codec_type === "video");

  video.aspect = aspect_round(video.width / video.height);

  return data;
}

function transcode(file, filelist) {
  return new Promise(async (resolve, reject) => {
    try {
      const list_idx = filelist.findIndex((f) => f === file) + 1;
      const profiles = [
        {
          name: "uhd",
          width: 3840,
          aspect: 16 / 9,
          bitrate: 18,
          codec: /hevc/,
          audio_codec: /aac|ac3/,
        },
        {
          name: "1080p",
          width: 1920,
          aspect: 16 / 9,
          bitrate: 5,
          codec: /hevc/,
          audio_codec: /aac|ac3/,
        },
        {
          name: "720p",
          width: 720,
          dest_width: 1920,
          aspect: 16 / 9,
          bitrate: 5,
          codec: /hevc/,
          audio_codec: /aac|ac3/,
        },
        {
          name: "hdv (1440p)",
          width: 1440,
          aspect: 4 / 3,
          bitrate: 5,
          codec: /hevc/,
          audio_codec: /aac|ac3/,
        },
        {
          name: "sd",
          width: 480,
          aspect: 4 / 3,
          bitrate: 2.5,
          codec: /hevc/,
          audio_codec: /aac|ac3/,
        },
        {
          name: "vertical",
          width: 1080,
          aspect: 9 / 16,
          bitrate: 8,
          codec: /hevc/,
          audio_codec: /aac|ac3/,
        },
      ].map((x) => ({ ...x, aspect: aspect_round(x.aspect) }));

      const ffprobe_data = await ffprobe(file);
      console.log(">> FFPROBE DATA >>", ffprobe_data);
      const video_stream = ffprobe_data.streams.find(
        (s) => s.codec_type === "video"
      );
      //get the audio stream, in english, with the highest channel count
      const audio_stream = ffprobe_data.streams
        .filter(
          (s) =>
            s.codec_type === "audio" && (!s.tags || s.tags.language === "eng")
        )
        .sort((a, b) => (a.channels > b.channels ? -1 : 1))[0];
      const subtitle_stream = ffprobe_data.streams.find(
        (s) => s.codec_type === "subtitle" && s.tags?.language === "eng"
      );
      let transcode_video = false;
      let transcode_audio = false;
      let video_filters = [];
      let audio_filters = [];

      const conversion_profile = profiles.find(
        (x) =>
          video_stream.width + 10 >= x.width && video_stream.aspect >= x.aspect
      );

      conversion_profile.width =
        conversion_profile.dest_width || conversion_profile.width;

      // if the codec doesn't match the profile
      if (!conversion_profile.codec.test(video_stream.codec_name)) {
        transcode_video = true;
      }

      // if the codec doesn't match the profile
      if (!conversion_profile.audio_codec.test(audio_stream.codec_name)) {
        transcode_audio = true;
        audio_filters.push("-c:a:0 aac");
      }

      if (
        ffprobe_data.format.bit_rate >
        conversion_profile.bitrate * 1024 * 1024
      ) {
        console.log("Video stream bitrate higher than conversion profile");
        transcode_video = true;
      }

      if (video_stream.width !== conversion_profile.width) {
        transcode_video = true;
        video_filters.push(
          `scale=${conversion_profile.width}:-2:flags=lanczos`
        );
      }

      console.log(audio_stream);

      if (audio_stream.channels > 2) {
        console.log("more than two audio channels");
        transcode_audio = true;
        audio_filters = audio_filters.concat([
          "-c:a:0 aac",
          "-b:a:0 192k",
          "-ac:a:0 2",
          "-filter:a:0 volume=2",
          "-c:a:1 copy",
          "-metadata:s:a:0 title=Stereo",
          "-metadata:s:a:0 language=eng",
          `-metadata:s:a:1 title=Original`,
          `-metadata:s:a:1 language=eng`,
        ]);
      }

      const input_maps = [
        `-map 0:${video_stream.index}`,
        `-map 0:${audio_stream.index}`,
      ];

      if (audio_filters.length > 0) {
        input_maps.push(`-map 0:${audio_stream.index}`);
      }

      if (subtitle_stream) {
        input_maps.push(`-map 0:${subtitle_stream.index}`, "-c:s copy");
      }

      if (ffprobe_data.chapters.length > 0) {
        input_maps.push(`-map_chapters ${video_stream.index}`);
      }

      let cmd = ffmpeg(file);

      cmd = cmd.outputOptions(input_maps);

      if (transcode_video) {
        const pix_fmt =
          video_stream.pix_fmt === "yuv420p" ? "yuv420p" : "yuv420p10le";
        cmd = cmd.outputOptions([
          "-c:v libx265",
          "-profile:v main10",
          "-level:v 4.0",
          `-pix_fmt ${pix_fmt}`,
        ]);

        if (pix_fmt === "yuv420p10le") {
          cmd = cmd.outputOptions([
            "-color_range tv",
            "-colorspace bt2020nc",
            "-color_primaries bt2020",
            "-color_trc smpte2084",
          ]);
        }
      } else {
        cmd = cmd.outputOptions("-c:v copy");
      }

      if (video_filters.length > 0) {
        cmd = cmd.outputOptions(["-vf", ...video_filters]);
      }

      cmd = cmd.outputOptions([
        `-maxrate ${conversion_profile.bitrate}M`,
        `-bufsize ${conversion_profile.bitrate * 3}M`,
        `-max_muxing_queue_size 9999`,
        `-threads 4`,
      ]);

      if (!transcode_audio) {
        cmd = cmd.outputOptions("-c:a copy");
      } else {
        cmd = cmd.outputOptions(audio_filters);
      }

      const dest_file = file.replace(/\.[A-Za-z0-9]+$/, ".tc.mkv");
      const lock_file = file.replace(/\.[A-Za-z0-9]+$/, ".tclock");

      let ffmpeg_cmd;

      let start_time;
      cmd = cmd
        .on("start", function (commandLine) {
          console.log("Spawned Ffmpeg with command: " + commandLine);
          start_time = moment();
          ffmpeg_cmd = commandLine;
          fs.writeFileSync(
            "/usr/app/output/filelist.json",
            JSON.stringify(filelist.slice(list_idx || list_idx + 1))
          );
        })
        .on("progress", function (progress) {
          const elapsed = moment().diff(start_time, "seconds");
          const run_time = moment.utc(elapsed * 1000).format("HH:mm:ss");
          const pct_per_second = progress.percent / elapsed;
          const seconds_pct = 1 / pct_per_second;
          const pct_remaining = 100 - progress.percent;
          const time_remaining = moment
            .utc(pct_remaining * seconds_pct * 1000)
            .format("HH:mm:ss");
          const estimated_final_kb =
            (progress.targetSize / progress.percent) * 100;
          const output = JSON.stringify(
            {
              ...progress,
              run_time,
              pct_per_second,
              pct_remaining,
              time_remaining,
              size: {
                progress: {
                  kb: progress.targetSize,
                  mb: progress.targetSize / 1024,
                  gb: progress.targetSize / 1024 / 1024,
                },
                estimated_final: {
                  kb: estimated_final_kb,
                  mb: estimated_final_kb / 1024,
                  gb: estimated_final_kb / 1024 / 1024,
                  change:
                    ((estimated_final_kb - ffprobe_data.format.size) /
                      ffprobe_data.format.size) *
                      100 +
                    "%",
                },
                original: {
                  kb: ffprobe_data.format.size,
                  mb: ffprobe_data.format.size / 1024,
                  gb: ffprobe_data.format.size / 1024 / 1024,
                },
              },
            },
            true,
            4
          );
          console.clear();
          console.log(">> JOB >>", {
            ...conversion_profile,
            ffmpeg_cmd,
            file,
            overall_progress: `(${list_idx}/${filelist.length})`,
          });

          console.log(">> PROGRESS >>", output);

          fs.writeFileSync(
            "/usr/app/output/active.json",
            JSON.stringify({
              ...conversion_profile,
              ffmpeg_cmd,
              file,
              overall_progress: `(${list_idx}/${filelist.length})`,
              output: JSON.parse(output),
            })
          );
        })
        .on("end", async function (stdout, stderr) {
          console.log("Transcoding succeeded!");
          console.log("Creating lockfile", lock_file);
          await exec_promise(`touch "${lock_file}"`);
          await trash(file);
          resolve();
        })
        .on("error", async function (err, stdout, stderr) {
          console.log("Cannot process video: ", err.message, stdout, stderr);
          await trash(dest_file);
          resolve();
        });
      cmd.save(dest_file);
    } catch (e) {
      console.log(">> TRANSCODE ERROR >>", e);
      resolve();
    }
  });
}

async function run() {
  try {
    await pre_sanitize();
    const filelist = await generate_filelist();

    console.log(">> FILELIST >>", filelist);
    await async.eachSeries(filelist, async (file) => {
      await transcode(file, filelist);
      return true;
    });
    console.log("Requeuing in 30 seconds...");
    setTimeout(() => {
      run();
    }, 30 * 1000);
  } catch (e) {
    console.log(">> ERROR >>", e);
    console.log("Requeuing in 30 seconds...");
    setTimeout(() => {
      run();
    }, 30 * 1000);
  }
}

run();
