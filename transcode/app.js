import { exec } from "child_process";
import async from "async";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import moment from "moment";
import File from "./models/files.js";
import Cleanup from "./models/cleanup.js";
import mongo_connect from "./lib/mongo_connection.js";
import cron from "node-cron";
import config from "./config.js";
import { aspect_round } from "./base-config.js";
import logger from "./lib/logger.js";

const PATHS = config.sources.map((p) => p.path);

const { encode_version, concurrent_file_checks } = config;

function exec_promise(cmd) {
  return new Promise((resolve, reject) => {
    logger.debug(cmd, { label: "Shell command" });
    exec(cmd, { maxBuffer: 1024 * 1024 * 500 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

function escape_file_path(file) {
  return file.replace(/(['])/g, "'\\''");
}

function trash(file) {
  return new Promise((resolve, reject) => {
    file = escape_file_path(file.replace(/\/$/g, "")).trim();
    exec(`rm '${file}'`, (error, stdout, stderr) => {
      if (error) {
        console.error(`exec error: ${error}`);
        reject(error);
      }
      resolve();
    });
  });
}

async function pre_sanitize() {
  await db_cleanup();
  const findCMD = `find ${PATHS.map((p) => `"${p}"`).join(
    " "
  )} -iname ".deletedByTMM" -type d -exec rm -Rf {} \\;`;
  await exec_promise(findCMD);
}

async function upsert_video(video) {
  try {
    const { path } = video;
    await File.findOneAndUpdate({ path }, video, { upsert: true });
  } catch (e) {
    logger.error(e, { label: "COULD NOT CONFIGURE SQL" });
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

    return videos || [];
  } catch (e) {
    logger.error(e, { label: "COULD NOT GET ENCODED VIDEOS" });
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
      logger.error(e, { label: "FFPROBE ERROR", file });

      await upsert_video({
        path: file,
        error: { error: e.message, stdout, stderr, trace: e.stack },
      });

      // if the file itself wasn't readable by ffprobe, remove it from the list
      if (/command\s+failed/gi.test(e.message)) {
        // if this is an unreadble file, trash it.
        const ext_expression = new RegExp("." + file_ext.join("|"), "i");
        if (ext_expression.test(e.message)) {
          logger.info(file, {
            label: "UNREADABLE VIDEO FILE. REMOVING FROM LIST",
          });
          trash(file);
        }
      }

      // if the video stream is corrupt, delete it
      if (/display_aspect_ratio/gi.test(e.message)) {
        logger.info(file, {
          label: "UNREADABLE VIDEO STREAM. REMOVING FROM LIST",
        });
        trash(file);
      }

      // any ffprobe command failure, this should be removed from the list
      filelist[file_idx] = null;

      return true;
    }
  });

  // remove falsey values from the list
  filelist = filelist.filter((file) => file);

  fs.writeFileSync("./filelist.txt", filelist.join("\n"));
  return filelist;
}

async function ffprobe(file) {
  const ffprobeCMD = `ffprobe -v quiet -print_format json -show_format -show_chapters -show_streams '${escape_file_path(
    file
  )}'`;
  const { stdout, stderr } = await exec_promise(ffprobeCMD);

  const data = JSON.parse(stdout);

  data.format.duration = +data.format.duration;
  data.format.size = +data.format.size;
  data.format.bit_rate = +data.format.bit_rate;
  data.format.size = +data.format.size / 1024;

  const video = data.streams.find((s) => s.codec_type === "video");

  if (video.display_aspect_ratio) {
    const [width, height] = video.display_aspect_ratio.split(":");
    video.aspect = aspect_round(width / height);
  } else {
    video.aspect = aspect_round(video.width / video.height);
  }

  return data;
}

function transcode(file, filelist) {
  return new Promise(async (resolve, reject) => {
    try {
      const list_idx = filelist.findIndex((f) => f === file) + 1;
      const { profiles } = config;

      const ffprobe_data = await ffprobe(file);
      logger.debug(ffprobe_data, { label: "FFPROBE DATA >>" });
      const video_stream = ffprobe_data.streams.find(
        (s) => s.codec_type === "video"
      );

      if (!video_stream) {
        throw new Error("No video stream found");
      }

      // get the scratch path
      const scratch_path = config.sources.find((p) =>
        file.startsWith(p.path)
      ).scratch;

      // get the filename
      const filename = file.match(/([^\/]+)$/)[1];

      // set the scratch file path and name
      const scratch_file = escape_file_path(
        `${scratch_path}/${filename}`.replace(/\.[A-Za-z0-9]+$/, ".tc.mkv")
      );

      // set the destination file path and name
      const dest_file = escape_file_path(
        file.replace(/\.[A-Za-z0-9]+$/, ".mkv")
      );

      // if this file has already been encoded, short circuit
      if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
        return resolve();
      }

      //get the audio stream, in english, with the highest channel count
      const audio_stream = ffprobe_data.streams
        .filter(
          (s) =>
            s.codec_type === "audio" &&
            (!s.tags?.language || /und|eng/i.test(s.tags.language))
        )
        .sort((a, b) => (a.channels > b.channels ? -1 : 1))[0];
      const subtitle_streams = ffprobe_data.streams.filter(
        (s) =>
          s.codec_type === "subtitle" &&
          s.tags?.language === "eng" &&
          /subrip|hdmv_pgs_subtitle/i.test(s.codec_name)
      );
      let transcode_video = false;
      let transcode_audio = false;
      let video_filters = [];
      let audio_filters = [];

      const conversion_profile = config.get_profile(video_stream);

      logger.debug(
        {
          video_stream_width: video_stream.width,
          video_stream_aspect: video_stream.aspect,
          conversion_profile,
          profiles,
        },
        { label: "Profile debug info" }
      );

      conversion_profile.width =
        conversion_profile.dest_width || conversion_profile.width;

      // if the video codec doesn't match the profile

      if (
        conversion_profile.output.video.codec_name !== video_stream.codec_name
      ) {
        transcode_video = true;
      }

      // if the audio codec doesn't match the profile
      if (
        conversion_profile.output.audio.codec_name !== audio_stream.codec_name
      ) {
        transcode_audio = true;
        audio_filters.push(
          `-c:a:0 ${conversion_profile.output.audio.codec}`,
          `-b:a:0 ${
            audio_stream.channels *
            conversion_profile.output.audio.per_channel_bitrate
          }k`
        );
      }

      // if the video codec matches the profile, but the bitrate is higher than the profile
      if (
        ffprobe_data.format.bit_rate >
          conversion_profile.bitrate * 1024 * 1024 &&
        !transcode_video
      ) {
        logger.debug(
          "Video stream bitrate higher than conversion profile. Transcoding"
        );
        transcode_video = true;
      }

      // if the input stream width doesn't equal the conversion profile width
      if (video_stream.width !== conversion_profile.width) {
        transcode_video = true;
        video_filters.push(
          `scale=${conversion_profile.width}:-2:flags=lanczos`
        );
      }

      // if the audio stream has more than two channels, and the profile is set to downmix, create a stereo version
      if (
        conversion_profile.output.audio.downmix &&
        audio_stream.channels > 2
      ) {
        logger.debug("more than two audio channels, downmixing");
        transcode_audio = true;
        audio_filters = audio_filters.concat([
          `-c:a:0 ${conversion_profile.output.audio.codec}`,
          `-b:a:0 ${
            audio_stream.channels *
            conversion_profile.output.audio.per_channel_bitrate
          }k`,
          `-c:a:1 ${conversion_profile.output.audio.codec}`,
          `-b:a:1 ${2 * conversion_profile.output.audio.per_channel_bitrate}k`,
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

      if (subtitle_streams.length > 0) {
        subtitle_streams.forEach((s) => {
          input_maps.push(`-map 0:${s.index}`);
        });

        input_maps.push("-c:s copy");
      }

      if (ffprobe_data.chapters.length > 0) {
        input_maps.push(`-map_chapters ${video_stream.index}`);
      }

      let cmd = ffmpeg(escape_file_path(file));

      cmd = cmd.outputOptions(input_maps);

      if (transcode_video) {
        const pix_fmt =
          video_stream.pix_fmt === "yuv420p" ? "yuv420p" : "yuv420p10le";

        conversion_profile.output.video.addFlags({
          maxrate: `${conversion_profile.output.video.bitrate}M`,
          bufsize: `${conversion_profile.output.video.bitrate * 3}M`,
          max_muxing_queue_size: 9999,
          pix_fmt: pix_fmt,
        });

        // handle HDR
        if (/arib[-]std[-]b67|smpte2084/i.test(video_stream.color_transfer)) {
          conversion_profile.name += ` (hdr)`; // add HDR to the profile name
          // temporarily disable in an effort to accommodate dolby vision
          // conversion_profile.addFlags({
          //   color_primaries: "bt2020",
          //   color_trc: "smpte2084",
          //   color_range: "tv",
          //   colorspace: "bt2020nc",
          // });
        }

        cmd = cmd.outputOptions([
          `-c:v ${conversion_profile.output.video.codec}`,
          ...Object.keys(conversion_profile.output.video.flags || {}).map(
            (k) => `-${k} ${conversion_profile.output.video.flags[k]}`
          ),
        ]);
      } else {
        cmd = cmd.outputOptions("-c:v copy");
      }

      if (video_filters.length > 0) {
        cmd = cmd.outputOptions(["-vf", ...video_filters]);
      }

      if (!transcode_audio) {
        cmd = cmd.outputOptions("-c:a copy");
      } else {
        // add unique audio filters to output options
        cmd = cmd.outputOptions(
          audio_filters.filter((prop, idx, self) => self.indexOf(prop) === idx)
        );
      }

      cmd = cmd.outputOptions(`-metadata encode_version=${encode_version}`);

      let ffmpeg_cmd;

      let start_time;
      cmd = cmd
        .on("start", async function (commandLine) {
          logger.debug("Spawned Ffmpeg with command: " + commandLine);
          start_time = moment();
          ffmpeg_cmd = commandLine;
          fs.writeFileSync(
            "/usr/app/output/filelist.json",
            JSON.stringify(filelist.slice(list_idx || list_idx + 1))
          );
          const video = await File.findOne({ path: file });

          if (video) {
            logger.debug(">> VIDEO FOUND -- REMOVING ERROR >>", video);
            video.error = undefined;
            await video.save();
          }
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
              video_stream,
              audio_stream,
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
          logger.debug(
            {
              ...conversion_profile,
              ffmpeg_cmd,
              file,
              overall_progress: `(${list_idx}/${filelist.length})`,
            },
            { label: "Job" }
          );

          logger.info(output);

          fs.writeFileSync(
            "/usr/app/output/active.json",
            JSON.stringify({
              ...conversion_profile,
              ffmpeg_cmd,
              audio_stream,
              video_stream,
              file,
              overall_progress: `(${list_idx}/${filelist.length})`,
              output: JSON.parse(output),
            })
          );
        })
        .on("end", async function (stdout, stderr) {
          logger.info("Transcoding succeeded!");

          await trash(file);
          await exec_promise(`mv '${scratch_file}' '${dest_file}'`);
          await upsert_video({
            path: dest_file,
            error: undefined,
            encode_version,
          });
          resolve();
        })
        .on("error", async function (err, stdout, stderr) {
          logger.error(err, { label: "Cannot process video", stdout, stderr });
          fs.appendFileSync(
            "/usr/app/logs/ffmpeg.log",
            JSON.stringify(
              {
                error: err.message,
                stdout,
                stderr,
                ffmpeg_cmd,
                trace: err.stack,
              },
              true,
              4
            )
          );
          await trash(scratch_file);
          await upsert_video({
            path: file,
            error: {
              error: err.message,
              stdout,
              stderr,
              ffmpeg_cmd,
              trace: err.stack,
            },
          });

          const corrupt_video_tests = [
            {
              test: /Invalid\s+NAL\s+unit\s+size/gi,
              message: "Invalid NAL unit size",
              obj: stderr,
            },
            {
              test: /unspecified\s+pixel\s+format/gi,
              message: "Unspecified pixel format",
              obj: stderr,
            },
            {
              test: /unknown\s+codec/gi,
              message: "Unknown codec",
              obj: stderr,
            },
            {
              test: /too\s+many\s+packets\s+buffered\s+for\s+output\s+stream/gi,
              message: "Too many packets buffered for output stream",
              obj: stderr,
            },
            {
              test: /invalid\s+data\s+found\s+when\s+processing\s+input/gi,
              message: "Invalid data found when processing input",
              obj: stderr,
            },
          ];

          const is_corrupt = corrupt_video_tests.find((t) =>
            t.test.test(t.obj)
          );

          // If this video is corrupted, trash it
          if (is_corrupt) {
            logger.info(is_corrupt, {
              label: "Source video is corrupt. Trashing",
            });
            await trash(file);
          }
          resolve();
        });
      cmd.save(scratch_file);
    } catch (e) {
      logger.error(e, { label: "TRANSCODE ERROR" });
      await upsert_video({
        path: file,
        error: { error: e.message, trace: e.stack },
      });
      if (/no\s+video\s+stream\s+found/gi.test(e.message)) {
        await trash(file);
      }
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

async function get_utilization() {
  const data = {
    memory: await exec_promise("free | grep Mem | awk '{print $3/$2 * 100.0}'"),
    cpu: await exec_promise("echo $(vmstat 1 2|tail -1|awk '{print $15}')"),
    last_updated: new Date(),
  };

  data.memory = Math.round(parseFloat(data.memory.stdout));
  data.cpu = Math.round(
    100 - parseFloat(data.cpu.stdout.replace(/[^0-9]+/g, ""))
  );

  fs.writeFileSync("/usr/app/output/utilization.json", JSON.stringify(data));

  setTimeout(() => {
    get_utilization();
  }, 10 * 1000);
}

async function run() {
  try {
    await create_scratch_disks();
    await get_utilization();
    await get_disk_space();
    await pre_sanitize();
    const filelist = await generate_filelist();
    logger.debug(filelist, { label: "File list" });
    await async.eachSeries(filelist, async (file) => {
      await transcode(file, filelist);
      return true;
    });
    logger.info("Requeuing in 30 seconds...");
    setTimeout(() => {
      run();
    }, 30 * 1000);
  } catch (e) {
    logger.error(e, { label: "ERROR" });
    logger.info("Requeuing in 30 seconds...");
    setTimeout(() => {
      run();
    }, 30 * 1000);
  }
}

async function db_cleanup() {
  const files = await File.find({}).sort({ path: 1 });
  const to_remove = files.map((f) => f.path).filter((p) => !fs.existsSync(p));

  // delete any file whose path doesn't exist
  await File.deleteMany({
    path: { $in: to_remove },
  });

  await Cleanup.create({ paths: to_remove, count: to_remove.length });
}

async function create_scratch_disks() {
  await exec_promise(
    `mkdir -p ${config.sources.map((p) => `"${p.scratch}"`).join(" ")}`
  );
}

mongo_connect()
  .then(() => {
    run();

    cron.schedule("0 */3 * * *", () => {
      db_cleanup();
    });
  })
  .catch((e) => {
    console.error(">> COULD NOT CONNECT TO MONGO >>", e);
  });
