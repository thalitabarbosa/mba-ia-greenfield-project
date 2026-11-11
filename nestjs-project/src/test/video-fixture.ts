import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Generates a small real MP4 (320x240, 25 fps, with audio) using ffmpeg's lavfi sources. */
export function generateTestVideo(durationSeconds = 3): Buffer {
  const file = join(tmpdir(), `fixture-${process.pid}-${Date.now()}.mp4`);
  const result = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=320x240:rate=25`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${durationSeconds}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-movflags',
    '+faststart',
    file,
  ]);
  if (result.status !== 0) {
    throw new Error(`ffmpeg fixture failed: ${result.stderr?.toString()}`);
  }
  const buffer = readFileSync(file);
  rmSync(file, { force: true });
  return buffer;
}
