import fs from "fs";
import File from "../models/files";
import Cleanup from "../models/cleanup";
import logger from "./logger";
import config from "./config";
import exec_promise from "./exec_promise";

export default async function db_cleanup() {
  logger.info("Cleaning up the database...");
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

  // purge aging scratch files from the scratch directories
  const scratch_paths = config.sources.map((p) => p.scratch);

  logger.info(
    `find ${scratch_paths.join(" ")} -type f -mtime +7 -exec rm {} \\;`,
    { label: "PURGING SCRATCH FILES" }
  );
  await exec_promise(
    `find ${scratch_paths.join(" ")} -type f -mtime +7 -exec rm {} \\;`
  );
}
