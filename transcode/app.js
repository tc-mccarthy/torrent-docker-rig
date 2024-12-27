import { exec } from "child_process";
import async from "async";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import dayjs from "./lib/dayjs.js";
import File from "./models/files.js";
import Cleanup from "./models/cleanup.js";
import ErrorLog from "./models/error.js";
import mongo_connect from "./lib/mongo_connection.js";
import cron from "node-cron";
import config from "./config.js";
import { aspect_round } from "./base-config.js";
import logger from "./lib/logger.js";
import { createClient } from "redis";
import rabbit_connect from "./lib/rabbitmq.js";
import chokidar from "chokidar";

const redisClient = createClient({ url: "redis://torrent-redis-local" });

const PATHS = config.sources.map((p) => p.path);

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
  "m2ts",
];

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
  return file.replace(/(['])/g, "'\\''").replace(/\n+$/, "");
}

function trash(file) {
  return new Promise(async (resolve, reject) => {
    if (!file) {
      return resolve();
    }

    // update the file's status to deleted
    await File.updateOne({ path: file }, { $set: { status: "deleted" } });

    file = escape_file_path(file.replace(/\/$/g, "")).trim();

    if (fs.existsSync(file)) {
      exec(`rm '${file}'`, (error, stdout, stderr) => {
        if (error) {
          console.error(`exec error: ${error}`);
          reject(error);
        }
        resolve();
      });
    } else {
      resolve();
    }
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
    let { path, record_id } = video;
    path = path.replace(/\n+$/, "");
    let file;

    if (record_id) {
      file = await File.findOne({ _id: record_id });
    }

    if (!file) {
      file = await File.findOne({ path });
    }

    if (!file) {
      file = new File(video);
    }

    // get priority from the video object, existing document or default to 100
    const priority =
      video.sortFields?.priority || file?.sortFields?.priority || 100;

    // merge the sortFields object with the priority
    const sortFields = { ...file.sortFields, priority };

    // merge the file object with the video object and override with sortFields
    file = Object.assign(file, video, { sortFields });

    await file.save();
  } catch (e) {
    logger.error(e, { label: "UPSERT FAILURE" });
  }
}

async function probe_and_upsert(file, record_id, opts = {}) {
  file = file.replace(/\n+$/, "");
  try {
    const current_time = dayjs();

    // check if the file exists
    if (!fs.existsSync(file)) {
      throw new Error("File not found");
    }

    const ffprobe_data = await ffprobe(file);

    await upsert_video({
      record_id,
      path: file,
      probe: ffprobe_data,
      encode_version: ffprobe_data.format.tags?.ENCODE_VERSION,
      last_probe: current_time,
      sortFields: {
        width: ffprobe_data.streams.find((s) => s.codec_type === "video")
          ?.width,
        size: ffprobe_data.format.size,
      },
      ...opts,
    });

    return ffprobe_data;
  } catch (e) {
    // if the file wasn't found
    if (/file\s+not\s+found/gi.test(e.message)) {
      await trash(file);
    }

    return false;
  }
}

async function generate_filelist() {
  // query for any files that have an encode version that doesn't match the current encode version
  let filelist = await File.find({
    encode_version: { $ne: encode_version },
    status: "pending",
  }).sort({
    "sortFields.priority": 1,
    "sortFields.size": -1,
    "sortFields.width": -1,
  });

  filelist = filelist.filter((f) => f.path);

  // remove first item from the list and write the rest to a file
  fs.writeFileSync(
    "./filelist.txt",
    filelist
      .slice(1)
      .map((f) => f.path)
      .join("\n")
  );
  fs.writeFileSync(
    "./output/filelist.json",
    JSON.stringify(
      filelist.slice(1, 1001).map((f) => ({
        path: f.path.split(/\//).pop(),
        size: f.sortFields.size,
        priority: f.sortFields.priority,
        resolution:
          f.probe.streams.find((v) => v.codec_type === "video").width * 0.5625, // use width at 56.25% to calculate resolution
        codec: `${
          f.probe.streams.find((v) => v.codec_type === "video")?.codec_name
        }/${f.probe.streams.find((v) => v.codec_type === "audio")?.codec_name}`,
        encode_version: f.encode_version,
      }))
    )
  );

  // send back full list
  return filelist.map((f) => f.path);
}

async function update_queue() {
  try {
    // check for a lock in redis
    const lock = await redisClient.get("update_queue_lock");

    // short circuit the function if the lock is set
    if (lock) {
      logger.info("Update queue locked. Exiting...");
      return;
    }

    // update the status of any files who have an encode version that matches the current encode version and that haven't been marked as deleted
    await File.updateMany(
      { encode_version, status: { $ne: "deleted" } },
      { $set: { status: "complete" } }
    );

    // get current date
    const current_date = dayjs().format("MMDDYYYY");
    // Get the list of files to be converted
    const last_probe_cache_key = `last_probe_${encode_version}_${current_date}_b`;

    // get the last probe time from redis
    const last_probe =
      (await redisClient.get(last_probe_cache_key)) || "1969-12-31 23:59:59";

    const current_time = dayjs();

    // get seconds until midnight
    const seconds_until_midnight =
      86400 - current_time.diff(current_time.endOf("day"), "seconds") - 60;

    logger.debug("Seconds until midnight", seconds_until_midnight);

    const findCMD = `find ${PATHS.map((p) => `"${p}"`).join(" ")} \\( ${file_ext
      .map((ext) => `-iname "*.${ext}"`)
      .join(" -o ")} \\) -not \\( -iname "*.tc.mkv" \\) -newermt "${dayjs(
      last_probe
    )
      .subtract(30, "minutes")
      .format("MM/DD/YYYY HH:mm:ss")}" -print0 | sort -z | xargs -0`;

    logger.info(findCMD, { label: "FIND COMMAND" });

    const { stdout, stderr } = await exec_promise(findCMD);

    let filelist = stdout
      .split(/\s*\/source_media/)
      .filter((j) => j)
      .map((p) => `/source_media${p}`.replace("\x00", ""))
      .slice(1);

    logger.info("", { label: "NEW FILES IDENTIFIED. PROBING..." });

    await async.eachLimit(filelist, concurrent_file_checks, async (file) => {
      const file_idx = filelist.indexOf(file);
      logger.info("Processing file", { file, file_idx, total: filelist.length, pct: Math.round((file_idx / filelist.length) * 100) });
      // set a 60 second lock with each file so that the lock lives no longer than 60 seconds beyond the final probe
      await redisClient.set("update_queue_lock", "locked", { EX: 60 });
      try {
        const ffprobe_data = await probe_and_upsert(file);

        // if the file is already encoded, remove it from the list
        if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
          filelist[file_idx] = null;
        }

        return true;
      } catch (e) {
        logger.error(e, { label: "FFPROBE ERROR", file });

        await upsert_video({
          path: file,
          error: { error: e.message, stdout, stderr, trace: e.stack },
          hasError: true,
        });

        await ErrorLog.create({
          path: file,
          error: { error: e.message, stdout, stderr, trace: e.stack },
        });

        // if the file itself wasn't readable by ffprobe, remove it from the list
        if (/command\s+failed/gi.test(e.message)) {
          // if this is an unreadable file, trash it.
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

    logger.info("", { label: "PROBE COMPLETE. UPDATING REDIS..." });

    await redisClient.set(
      last_probe_cache_key,
      current_time.format("MM/DD/YYYY HH:mm:ss"),
      { EX: seconds_until_midnight }
    );

    // clear the lock
    await redisClient.del("update_queue_lock");

    logger.info("", { label: "REDIS UPDATED" });
  } catch (e) {
    logger.error(e, { label: "UPDATE QUEUE ERROR" });
  }
}

async function ffprobe(file) {
  try {
    const ffprobeCMD = `ffprobe -v quiet -print_format json -show_format -show_chapters -show_streams '${escape_file_path(
      file
    )}'`;
    logger.info(ffprobeCMD, { label: "FFPROBE COMMAND" });
    const { stdout, stderr } = await exec_promise(ffprobeCMD);

    logger.debug({ stdout, stderr }, { label: "FFPROBE OUTPUT" });

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
  } catch (e) {
    if (/command\s+failed/gi.test(e.message)) {
      trash(file);
    }
    logger.error("FFPROBE FAILED", e);
    return false;
  }
}

function transcode(file) {
  return new Promise(async (resolve, reject) => {
    try {
      const { profiles } = config;
      // mongo record of the video
      const video_record = await File.findOne({ path: file });
      const exists = fs.existsSync(file);

      if (!exists) {
        throw new Error("File not found");
      }

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
      const scratch_file = `${scratch_path}/${filename}`.replace(
        /\.[A-Za-z0-9]+$/,
        ".tc.mkv"
      );

      // set the destination file path and name
      const dest_file = file.replace(/\.[A-Za-z0-9]+$/, ".mkv");

      // if this file has already been encoded, short circuit
      if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
        logger.info(
          {
            file,
            encode_version: ffprobe_data.format.tags?.ENCODE_VERSION,
          },
          { label: "File already encoded" }
        );
        video_record.encode_version = ffprobe_data.format.tags?.ENCODE_VERSION;
        await video_record.save();
        return resolve();
      }

      //get the audio stream, in english unless otherwise specified, with the highest channel count
      const audio_stream_test = new RegExp(
        video_record.audio_language || "und|eng",
        "i"
      ); // if the record has an audio language specified on it, honor that
      const audio_stream = ffprobe_data.streams
        .filter(
          (s) =>
            s.codec_type === "audio" &&
            (!s.tags?.language || audio_stream_test.test(s.tags.language))
        )
        .sort((a, b) => (a.channels > b.channels ? -1 : 1))[0];

      if (!audio_stream) {
        throw new Error("No audio stream found");
      }

      const subtitle_streams = ffprobe_data.streams.filter(
        (s) =>
          s.codec_type === "subtitle" &&
          s.tags?.language === "eng" &&
          /subrip|hdmv_pgs_subtitle|substation/i.test(s.codec_name)
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
          `-metadata:s:a:1 language=${audio_stream.tags?.language || "eng"}`,
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
        input_maps.push(`-map_chapters 0`);
      }

      let cmd = ffmpeg(file);

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
          logger.info("Spawned Ffmpeg with command: " + commandLine);
          start_time = dayjs();
          ffmpeg_cmd = commandLine;

          if (video_record) {
            logger.debug(">> VIDEO FOUND -- REMOVING ERROR >>", video_record);
            video_record.error = undefined;
            video_record.transcode_details = {
              start_time: start_time.toDate(),
              source_codec: `${
                video_record.probe.streams.find((f) => f.codec_type === "video")
                  ?.codec_name
              }_${
                video_record.probe.streams.find((f) => f.codec_type === "audio")
                  ?.codec_name
              }`,
            };
            await video_record.save();
          }
        })
        .on("progress", function (progress) {
          const elapsed = dayjs().diff(start_time, "seconds");
          const run_time = dayjs.utc(elapsed * 1000).format("HH:mm:ss");
          const pct_per_second = progress.percent / elapsed;
          const seconds_pct = 1 / pct_per_second;
          const pct_remaining = 100 - progress.percent;
          const est_completed_seconds = pct_remaining * seconds_pct;
          const time_remaining = dayjs
            .utc(est_completed_seconds * 1000)
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
              est_completed_seconds,
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
            },
            { label: "Job" }
          );

          logger.debug(output);

          fs.writeFileSync(
            "/usr/app/output/active.json",
            JSON.stringify({
              ...conversion_profile,
              ffmpeg_cmd,
              audio_stream,
              video_stream,
              file,
              output: JSON.parse(output),
            })
          );
        })
        .on("end", async function (stdout, stderr) {
          logger.info("Transcoding succeeded!");

          // delete the original file
          await trash(file);

          // move the transcoded file to the destination and touch it so it's picked up by scans
          await exec_promise(
            `mv '${escape_file_path(scratch_file)}' '${escape_file_path(
              dest_file
            )}' && touch '${escape_file_path(dest_file)}'`
          );

          await probe_and_upsert(dest_file, video_record._id, {
            transcode_details: {
              ...video_record.transcode_details,
              end_time: dayjs().toDate(),
              duration: dayjs().diff(start_time, "seconds"),
            },
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
            hasError: true,
          });

          await ErrorLog.create({
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
            {
              test: /could\s+not\s+open\s+encoder\s+before\s+eof/gi,
              message: "Could not open encoder before End of File",
              obj: stderr,
            },
            {
              test: /command\s+failed/gi,
              message: "FFProbe command failed, video likely corrupt",
              obj: stderr,
            },
            {
              test: /ffmpeg\s+was\s+killed\s+with\s+signal\s+SIGFPE/i,
              message: "FFMpeg processing failed, video likely corrupt",
              obj: stderr,
            },
            {
              test: /[-]22/i,
              message: "Unrecoverable Errors were found in the source",
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
            // don't await the delete in case the problem is a missing file
            trash(file);
            await File.deleteOne({ path: file });
          }
          resolve();
        });
      cmd.save(scratch_file);
    } catch (e) {
      logger.error(e, { label: "TRANSCODE ERROR" });
      await upsert_video({
        path: file,
        error: { error: e.message, trace: e.stack },
        hasError: true,
      });

      await ErrorLog.create({
        path: file,
        error: { error: e.message, trace: e.stack },
      });

      if (/no\s+(video|audio)\s+stream\s+found/gi.test(e.message)) {
        await trash(file);
      }

      if (/file\s+not\s+found/gi.test(e.message)) {
        await trash(file);
      }

      resolve();
    }
  });
}

function get_disk_space() {
  clearTimeout(global.disk_space_timeout);
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
        global.disk_space_timeout = setTimeout(() => {
          get_disk_space();
        }, 10 * 1000);
        resolve(rows);
      }
    });
  });
}

async function get_utilization() {
  clearTimeout(global.utilization_timeout);

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

  global.utilization_timeout = setTimeout(() => {
    get_utilization();
  }, 10 * 1000);
}

async function update_status() {
  const data = {
    processed_files: await File.countDocuments({ encode_version }),
    total_files: await File.countDocuments(),
    unprocessed_files: await File.countDocuments({
      encode_version: { $ne: encode_version },
    }),
    library_coverage:
      ((await File.countDocuments({ encode_version })) /
        (await File.countDocuments())) *
      100,
  };

  fs.writeFileSync("/usr/app/output/status.json", JSON.stringify(data));
}

function transcode_loop() {
  return new Promise(async (resolve, reject) => {
    logger.info("STARTING TRANSCODE LOOP");
    const filelist = await generate_filelist();
    logger.info(
      "FILE LIST ACQUIRED. THERE ARE " +
        filelist.length +
        " FILES TO TRANSCODE."
    );

    // if there are no files, wait 1 minute and try again
    if (filelist.length === 0) {
      return setTimeout(() => {
        return transcode_loop();
      }, 60 * 1000);
    }

    await update_status();
    const file = filelist[0];
    logger.info("BEGINNING TRANSCODE");
    await transcode(file);

    // if there are more files, run the loop again
    if (filelist.length > 1) {
      return transcode_loop();
    }

    resolve();
  });
}

async function run() {
  try {
    logger.info("Creating scratch space");
    await create_scratch_disks();
    logger.info("Getting system utilization values");
    await get_utilization();
    logger.info("Getting disk space");
    await get_disk_space();
    logger.info("Cleaning up the FS before running the queue");
    await pre_sanitize();

    // parallelize the detection of new videos
    logger.info("Startup complete. Updating the queue...");
    update_queue();

    logger.info("Starting transcode loop...");
    await transcode_loop();

    logger.info("Requeuing in 30 seconds...");
    global.runTimeout = setTimeout(() => {
      run();
    }, 30 * 1000);
  } catch (e) {
    logger.error(e, { label: "ERROR" });
    logger.info("Requeuing in 30 seconds...");
    global.runTimeout = setTimeout(() => {
      run();
    }, 30 * 1000);
  }
}

async function db_cleanup() {
  // first purge any files marked for delete
  await File.deleteMany({ status: "deleted" });

  // then verify that all remaining files exist in the filesystem
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
  .then(() => redisClient.connect())
  .then(() => rabbit_connect())
  .then(({ send, receive }) => {
    logger.info("Connected to RabbitMQ");
    logger.info("Starting main thread");
    run();

    logger.info("Establishing file watcher");
    // establish fs event listeners on the watched directories
    logger.debug("Configuring watcher for paths: ", PATHS);
    const watcher = chokidar.watch(PATHS, {
      ignored: (file, stats) => {
        //if .deletedByTMM is in the path, ignore
        if (file.includes(".deletedByTMM")) {
          return true;
        }

        // if the file doesn't have a file extension at all, or it has an approved file_ext do not ignore
        if (!/\.[A-Za-z0-9]+$/i.test(file)) {
          return false;
        }

        return !file_ext.some((ext) => new RegExp(`.${ext}$`, "i").test(file));
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: true
    });

    watcher
      .on("ready", () => {
        logger.debug(
          ">> WATCHER IS READY AND WATCHING >>",
          watcher.getWatched()
        );
      })
      .on("error", (error) => logger.error(`Watcher error: ${error}`))
      .on("add", (path) => {
        if (file_ext.some((ext) => new RegExp(`.${ext}$`, "i").test(path))) {
          logger.debug(">> NEW FILE DETECTED >>", path);
          send({ path });
        }
      })
      .on("change", (path) => {
        if (file_ext.some((ext) => new RegExp(`.${ext}$`, "i").test(path))) {
          logger.debug(">> FILE CHANGE DETECTED >>", path);
          send({ path });
        }
      })
      .on("unlink", (path) => {
        if (file_ext.some((ext) => new RegExp(`.${ext}$`, "i").test(path))) {
          logger.debug(">> FILE DELETE DETECTED >>", path);
          send({ path });
        }
      });

    logger.info("Creating message consumer");
    // listen for messages in rabbit and run an probe and upsert on the paths
    receive(async (msg, message_content, channel) => {
      try {
        await probe_and_upsert(message_content.path);
        channel.ack(msg);
      } catch (e) {
        logger.error(e, { label: "RABBITMQ ERROR" });
        channel.ack(msg);
      }
    });

    logger.info("Scheduling jobs");
    cron.schedule("0 */3 * * *", () => {
      db_cleanup();
    });

    cron.schedule("*/5 * * * *", () => {
      update_queue();
    });
  })
  .catch((e) => {
    console.error(">> COULD NOT CONNECT TO MONGO >>", e);
  });
