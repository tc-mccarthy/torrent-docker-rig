import fs from 'node:fs/promises';
import path from 'node:path';

export default async function moveFile (oldPath, newPath) {
  try {
    // Ensure the destination directory exists, creating it recursively if needed
    await fs.mkdir(path.dirname(newPath), { recursive: true });

    // Attempt to rename (move) the file
    await fs.rename(oldPath, newPath);
    console.log(`File moved successfully from ${oldPath} to ${newPath}`);
    return true;
  } catch (error) {
    if (error.code === 'EXDEV') {
      // Handle cross-device moves by copying and then deleting the original
      console.warn(`Cannot move across devices. Copying from ${oldPath} to ${newPath} instead.`);
      await fs.copyFile(oldPath, newPath);
      await fs.unlink(oldPath);
      console.log(`File copied and original deleted successfully.`);
      return true;
    }
    console.error(`Error moving file: ${error.message}`);
    throw error; // Re-throw other errors
  }
}
