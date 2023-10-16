import { exec } from "child_process";
import async from "async";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import moment from "moment";
import File from "./models/files.js";

const PATHS = process.env.TRANSCODE_PATHS.split(/[,]\s*\//).map(
  (path) => "/" + path
);

const encode_version = "20230608a";
const concurrent_file_checks = 30;

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

function trash(file) {
  return new Promise((resolve, reject) => {
    file = file.replace(/\/$/g, "").trim();
    exec(`rm "${file}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        reject(error);
      }
      resolve();
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

async function upsert_video(video) {
  try {
    const { path } = video;
    await File.findOneAndUpdate({ path }, video, { upsert: true });
  } catch (e) {
    console.log(">> COULD NOT CONFIGURE SQL >>", e);
  }
}

async function get_encoded_videos() {
  try {
    const timestamp = new Date(new Date().setDate(new Date().getDate() - 30));
    let videos = await File.find({
      updated_at: { $gte: timestamp },
      encode_version,
    });

    videos = videos.map((video) => video.path);

    return videos;
  } catch (e) {
    console.log(">> COULD NOT CONFIGURE SQL >>", e);
  }
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
    .join(
      " -o "
    )} \\) -not \\( -iname "*.tc.mkv" \\) -print0 | sort -z | xargs -0`;

  const { stdout, stderr } = await exec_promise(findCMD);

  let filelist = stdout
    .split(/\s*\/source_media/)
    .filter((j) => j)
    .map((p) => `/source_media${p}`.replace("\x00", ""))
    .slice(1);

  const encoded_videos = await get_encoded_videos();

  // filter out any paths in the filelist that are in the list of encoded videos as they've already been encoded
  filelist = filelist.filter((file) => encoded_videos.indexOf(file) === -1);

  // remove any videos that already have the current encode version in the metadata
  await async.eachLimit(filelist, concurrent_file_checks, async (file) => {
    const file_idx = filelist.indexOf(file);
    try {
      const ffprobe_data = await ffprobe(file);

      // if the file is already encoded, remove it from the list
      if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
        filelist[file_idx] = null;
      }

      await upsert_video({
        path: file,
        probe: ffprobe_data,
        encode_version: ffprobe_data.format.tags?.ENCODE_VERSION,
      });

      return true;
    } catch (e) {
      console.log(">> FFPROBE ERROR >>", e);

      // if the file itself wasn't readable by ffprobe, remove it from the list
      if (/command\s+failed/i.test(e.message)) {
        // if this is an unreadble file, trash it.
        const ext_expression = new RegExp("." + file_ext.join("|"), "i");
        if (ext_expression.test(e.message)) {
          console.log(">> UNREADABLE VIDEO FILE. REMOVING FROM LIST >>");
          trash(file);
        }

        // any ffprobe command failure, this should be removed from the list
        filelist[file_idx] = null;
      }

      return true;
    }
  });

  // remove falsey values from the list
  filelist = filelist.filter((file) => file);

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
          bitrate: 25,
          codec: /libsvtav1/,
          audio_codec: /libopus/,
        },
        {
          name: "1080p",
          width: 1920,
          aspect: 16 / 9,
          bitrate: 7,
          codec: /libsvtav1/,
          audio_codec: /libopus/,
        },
        {
          name: "720p",
          width: 720,
          dest_width: 1920,
          aspect: 16 / 9,
          bitrate: 7,
          codec: /libsvtav1/,
          audio_codec: /libopus/,
        },
        {
          name: "hdv (1440p)",
          width: 1440,
          aspect: 4 / 3,
          bitrate: 7,
          codec: /libsvtav1/,
          audio_codec: /libopus/,
        },
        {
          name: "sd",
          width: 480,
          aspect: 4 / 3,
          bitrate: 3.5,
          codec: /libsvtav1/,
          audio_codec: /libopus/,
        },
        {
          name: "vertical",
          width: 1080,
          aspect: 9 / 16,
          bitrate: 12,
          codec: /libsvtav1/,
          audio_codec: /libopus/,
        },
      ].map((x) => ({ ...x, aspect: aspect_round(x.aspect) }));

      const ffprobe_data = await ffprobe(file);
      console.log(">> FFPROBE DATA >>", ffprobe_data);
      const video_stream = ffprobe_data.streams.find(
        (s) => s.codec_type === "video"
      );

      const dest_file = file.replace(/\.[A-Za-z0-9]+$/, ".tc.mkv");

      // if this file has already been encoded, short circuit
      if (ffprobe_data.format.tags.ENCODE_VERSION === encode_version) {
        return resolve();
      }

      //get the audio stream, in english, with the highest channel count
      const audio_stream = ffprobe_data.streams
        .filter(
          (s) =>
            s.codec_type === "audio" &&
            (!s.tags?.language || s.tags.language === "eng")
        )
        .sort((a, b) => (a.channels > b.channels ? -1 : 1))[0];
      const subtitle_stream = ffprobe_data.streams.find(
        (s) =>
          s.codec_type === "subtitle" &&
          s.tags?.language === "eng" &&
          /srt|pgs/i.test(s.codec_name)
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
        audio_filters.push("-c:a:0 libopus");
      }

      if (
        ffprobe_data.format.bit_rate >
          conversion_profile.bitrate * 1024 * 1024 ||
        ffprobe_data.format.codec_name !== "av1"
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
          "-c:a:0 libopus",
          `-b:a:0 ${audio_stream.channels * 56}k`,
          "-c:a:1 libopus",
          "-b:a:1 112k",
          "-ac:a:1 2",
          "-metadata:s:a:1 title=Stereo",
          "-metadata:s:a:1 language=eng",
        ]);

        if (audio_stream.channels === 6) {
          audio_filters.push("-af:0 channelmap=channel_layout=5.1");
        }
      }

      const input_maps = [
        `-map 0:${video_stream.index}`,
        `-map 0:${audio_stream.index}`,
      ];

      // only map audio a second time if we're going to be down mixing to stereo
      if (audio_stream.channels > 2) {
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
          "-c:v libsvtav1",
          "-preset 8",
          "-crf 35",
          `-pix_fmt ${pix_fmt}`,
        ]);

        // handle HDR
        if (/arib[-]std[-]b67|smpte2084/i.test(video_stream.color_transfer)) {
          cmd = cmd.outputOptions([
            "-color_range tv",
            "-colorspace bt2020nc",
            "-color_primaries bt2020",
            "-color_trc smpte2084",
          ]);

          conversion_profile.name += ` HDR`;
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

      cmd = cmd.outputOptions(`-metadata encode_version=${encode_version}`);

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

          await trash(file);
          await exec_promise(
            `mv "${dest_file}" "${dest_file.replace(/\.tc/i, "")}"`
          );
          resolve();
        })
        .on("error", async function (err, stdout, stderr) {
          console.log("Cannot process video: ", err.message, stdout, stderr);
          fs.appendFileSync(
            "/usr/app/logs/ffmpeg.log",
            JSON.stringify(
              { error: err.message, stdout, stderr, ffmpeg_cmd },
              true,
              4
            )
          );
          await trash(dest_file);
          await upsert_video({ path: file, error: err.message });
          resolve();
        });
      cmd.save(dest_file);
    } catch (e) {
      console.log(">> TRANSCODE ERROR >>", e);
      resolve();
    }
  });
}

function get_disk_space() {
  return new Promise((resolve, reject) => {
    exec("df -h", (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        let rows = stdout.split(/\n+/).map((row) => row.split(/\s+/));
        rows = rows
          .splice(1)
          .map((row) => {
            const obj = {};
            rows[0].forEach((value, idx) => {
              obj[value.toLowerCase().replace(/[^A-Za-z0-9]+/i, "")] = row[idx];
            });
            return obj;
          })
          .filter(
            (obj) =>
              PATHS.findIndex((path) => {
                if (obj.mounted) {
                  return path.indexOf(obj.mounted) > -1;
                } else {
                  return false;
                }
              }) > -1
          );
        fs.writeFileSync("/usr/app/output/disk.json", JSON.stringify(rows));
        setTimeout(() => {
          get_disk_space();
        }, 10 * 1000);
        resolve(rows);
      }
    });
  });
}

async function run() {
  try {
    await pre_sanitize();
    const filelist = await generate_filelist();
    console.log(">> FILELIST >>", filelist);
    await get_disk_space();
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
