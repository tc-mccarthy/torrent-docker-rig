
import { eachLimit, asyncify } from 'async';
import { rename, access } from 'fs/promises';
import { constants } from 'fs';
import File from '../models/files';
import logger from './logger';

/**
 * Finds all files in the File model that have audio tracks encoded with libfdk_aac and more than two channels.
 * For each matching file, renames the file to indicate it contains FDK AAC surround audio.
 *
 * This function demonstrates how to query for specific audio encoding properties and process results in parallel.
 *
 * @async
 * @function downgradeAudio
 * @returns {Promise<void>} Resolves when all files have been processed.
 */
export async function downgradeAudio () {
  // Query the File collection for files with:
  // - At least one audio stream
  // - codec_name: 'aac' (AAC audio)
  // - ENCODER tag matching 'libfdk_aac' (case-insensitive, with optional _ or -)
  // - More than two channels (surround audio)
  const filelist = await File.find({
    path: { $not: /fdk_surround/ }, // Exclude files already marked as fdk_surround
    'probe.streams': {
      $elemMatch: {
        codec_type: 'audio',
        codec_name: 'aac',
        'tags.ENCODER': { $regex: 'libfdk[_-]?aac', $options: 'i' },
        channels: { $gt: 2 }
      }
    }
  });

  // Process each file in parallel (up to 2 at a time for safety)
  // For each file, rename it to indicate FDK AAC surround audio
  await eachLimit(
    filelist,
    2,
    asyncify(async (file) => {
      try {
        // Construct the new file name by appending '_fdk_surround' before the extension
        const newFileName = file.path.replace(/\.mkv$/, '_fdk_surround.mkv');
        await access(file.path, constants.F_OK);

        // Rename the file on disk
        await rename(file.path, newFileName);
      } catch (err) {
        logger.error(`Error processing file ${file.path}: ${err.message}`);
      } finally {
        return true;
      }
    })
  );
}
