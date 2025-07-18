// ffmpegFormatter.js

/**
 * Beautifies an FFmpeg command by placing each argument/value on a new line.
 *
 * @param {string} command - The raw FFmpeg command string.
 * @returns {string} - A human-readable, line-separated version of the command.
 */
export default function formatFFmpegCommandSimple (command) {
  if (!command.trim().startsWith('ffmpeg')) return command;

  const tokens = command.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const output = ['ffmpeg \\'];

  // Skip the first token ("ffmpeg")
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.startsWith('-')) {
      const next = tokens[i + 1];

      if (!next || next.startsWith('-')) {
        output.push(`  ${token} \\`);
      } else {
        output.push(`  ${token} ${next} \\`);
        i += 1; // Skip next token
      }
    } else {
      // Positional argument (e.g., input or output file)
      output.push(`  ${token} \\`);
    }
  }

  // Remove the trailing backslash from the last line
  output[output.length - 1] = output[output.length - 1].replace(/\\$/, '');

  return output.join('\n');
}
