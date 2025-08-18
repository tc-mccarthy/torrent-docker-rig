import fs from 'fs';
import File from '../models/files';
import exec_promise from './exec_promise';
import config from './config';

/**
 * Escape a file path for safe use in shell commands.
 *
 * Replaces double quotes with escaped quotes and trims trailing newlines.
 *
 * @param {string} file - The file path to escape.
 * @returns {string} - The escaped file path.
 */
export function escape_file_path (file) {
  return file.replace(/(["])/g, '\\"').replace(/\n+$/, '');
}

/**
 * Generate scratch and destination file paths for a given input file.
 *
 * - The scratch path is based on the source config and uses a normalized filename.
 * - The destination path is the original path with the extension replaced by .mkv.
 *
 * @param {string} file - The original file path.
 * @returns {{ scratch_file: string, dest_file: string }} - Paths for scratch and destination files.
 * @throws {Error} If the filename format is invalid.
 */
export function generate_file_paths (file) {
  // Find the source config for the file
  const source = config.sources.find((p) => file.startsWith(p.path));
  if (!source) {
    throw new Error(`No source config found for file: ${file}`);
  }
  const scratch_path = source.scratch;
  const stage_path = source.stage_path;

  // Extract the filename from the path
  const filename = file.match(/([^/]+)$/)[1];

  // Capture the filename and extension in separate variables
  const match = filename.match(/(.+)[.]([A-Za-z0-9]+)$/);
  if (!match) {
    throw new Error(`Invalid filename format: ${filename}`);
  }
  const name = match[1];

  // Build the normalized base name
  const normalized = name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();

  // Build the scratch file path with _scratch suffix
  const scratch_file = `${scratch_path}/${normalized}_scratch.mkv`;

  // Build the stage file path with _stage suffix, or false if stage_path is falsey
  let stage_file = false;
  if (stage_path) {
    stage_file = `${stage_path}/${normalized}_stage.mkv`;
  }

  // Build the destination file path by replacing the extension with .mkv
  const dest_file = file.replace(/\.[A-Za-z0-9]+$/, '.mkv');

  return {
    scratch_file,
    stage_file,
    dest_file
  };
}

/**
 * Move a file to the trash and update its status in the database.
 *
 * - Marks the file as deleted in the database.
 * - Removes the file from disk if it exists.
 * - Optionally deletes the file record from the database.
 *
 * @param {string} file - The file path to delete.
 * @param {boolean} [record=true] - Whether to delete the DB record as well.
 * @returns {Promise<boolean>} - True if successful.
 */
export async function trash (file, record = true) {
  if (!file) {
    return true;
  }

  // Update the file's status to deleted in the DB
  await File.updateOne({ path: file }, { $set: { status: 'deleted' } });

  // Escape and trim the file path
  file = escape_file_path(file.replace(/\/$/g, '')).trim();

  // Remove the file from disk if it exists
  if (fs.existsSync(file)) {
    await fs.promises.unlink(file);
  }

  // Optionally delete the file record from the DB
  if (record) {
    await File.deleteOne({ path: file });
  }

  return true;
}

/**
 * Create all scratch and source directories as needed.
 *
 * Uses `mkdir -p` to ensure all paths exist for both sources and their scratch disks.
 *
 * @returns {Promise<void>}
 */
export async function create_scratch_disks () {
  await exec_promise(
    `mkdir -p ${config.sources
      .map((p) => `"${p.path}" "${p.scratch}"`)
      .join(' ')}`
  );
}
