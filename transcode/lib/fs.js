import fs from "fs";
import File from "../models/files";
import exec_promise from "./exec_promise";
import config from "./config";

export function escape_file_path(file) {
  return file.replace(/(["])/g, '\\"').replace(/\n+$/, "");
}

export function generate_file_paths(file) {
  // get the scratch path
  const scratch_path = config.sources.find((p) =>
    file.startsWith(p.path)
  ).scratch;

  // get the filename
  const filename = file.match(/([^/]+)$/)[1];

  // capture the filename and extension in seaprate variables
  const match = filename.match(/(.+)[.]([A-Za-z0-9]+)$/);

  if (!match) {
    throw new Error(`Invalid filename format: ${filename}`);
  }

  const name = match[1];

  // set the scratch file path and name
  const scratch_file = `${scratch_path}/${name
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()}-${Date.now()}.mkv`;

  // set the destination file path and name
  const dest_file = file.replace(/\.[A-Za-z0-9]+$/, ".mkv");

  return {
    scratch_file,
    dest_file,
  };
}

export async function trash(file, record = true) {
  if (!file) {
    return true;
  }

  // update the file's status to deleted
  await File.updateOne({ path: file }, { $set: { status: "deleted" } });

  file = escape_file_path(file.replace(/\/$/g, "")).trim();

  if (fs.existsSync(file)) {
    await fs.promises.unlink(file);
  }

  if (record) {
    await File.deleteOne({ path: file });
  }

  return true;
}

export async function create_scratch_disks() {
  await exec_promise(
    `mkdir -p ${config.sources
      .map((p) => `"${p.path}" "${p.scratch}"`)
      .join(" ")}`
  );
}
