import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import dayjs from "dayjs";
import File from "../models/files";
import ffprobe from "./ffprobe";
import config from "./config";
import logger from "./logger";
import memcached from "./memcached";
import { trash } from "./fs";

const { encode_version } = config;

export default function integrityCheck(file) {
  return new Promise(async (resolve, reject) => {
    try {
      // mongo record of the video
      logger.info("INTEGRITY CHECKING FILE", file);
      const video_record = await File.findOne({ path: file });
      const locked = await memcached.get(`integrity_lock_${video_record._id}`);
      // if the file is locked, short circuit
      if (locked) {
        logger.info(
          `File is locked. Skipping integrity check: ${file} - ${video_record._id}`
        );
        return resolve();
      }

      await memcached.set(`integrity_lock_${video_record._id}`, "locked", 5);

      const exists = fs.existsSync(file);

      if (!exists) {
        throw new Error(`File not found: ${file}`);
      }

      const ffprobe_data = await ffprobe(file);

      const video_stream = ffprobe_data.streams.find(
        (s) => s.codec_type === "video"
      );

      if (!video_stream) {
        throw new Error("No video stream found");
      }

      // if this file has already been encoded, short circuit
      if (ffprobe_data.format.tags?.ENCODE_VERSION === encode_version) {
        logger.info(
          {
            file,
            encode_version: ffprobe_data.format.tags?.ENCODE_VERSION,
            integrityCheck: true,
          },
          { label: "File already encoded" }
        );
        video_record.encode_version = ffprobe_data.format.tags?.ENCODE_VERSION;
        video_record.integrityCheck = true;
        video_record.status = "complete";
        await video_record.save();
        return resolve();
      }

      // get the audio stream, in english unless otherwise specified, with the highest channel count
      const audio_stream_test = new RegExp(
        (video_record.audio_language || ["und", "eng"]).join("|"),
        "i"
      );

      // preserve the audio lines specified in the video record, sorted by channel count
      const audio_streams = ffprobe_data.streams
        .filter(
          (s) =>
            s.codec_type === "audio" &&
            (!s.tags?.language || audio_stream_test.test(s.tags.language))
        )
        .sort((a, b) => (a.channels > b.channels ? -1 : 1));

      if (!audio_streams?.length) {
        throw new Error("No audio stream found");
      }

      let start_time;

      ffmpeg(file)
        .inputOptions("-v error")
        .outputOptions(["-f null"])
        .on("start", async (commandLine) => {
          logger.info(`Spawned integrity check with command: ${commandLine}`);
          start_time = dayjs();

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
        .on("progress", (progress) => {
          // set a 5 second lock on the video record
          memcached.set(`integrity_lock_${video_record._id}`, "locked", 5);
        })
        .on("end", async (stdout, stderr) => {
          try {
            logger.info("FFMPEG INTEGRITY CHECK COMPLETE", { stdout, stderr });
            if (!stdout.trim() && !stderr.trim()) {
              logger.info("No output from ffmpeg, so no errors found");
              video_record.integrityCheck = true;
              await video_record.save();
            } else {
              logger.info("OUTPUT DETECTED, ERRORS MUST HAVE BEEN FOUND");
              await trash(file);
            }
          } catch (e) {
            logger.error(e, { label: "POST INTEGRITY CHECK ERROR" });
          } finally {
            resolve();
          }
        })
        .on("error", async (err, stdout, stderr) => {
          logger.error(err, { label: "Cannot process video during integrity check", stdout, stderr });
          
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
        }).save("-")
    } catch (e) {
      logger.error(e, { label: "INTEGRITY CHECK ERROR" });

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
