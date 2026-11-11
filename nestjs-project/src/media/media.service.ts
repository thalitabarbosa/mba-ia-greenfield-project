import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { FfprobeOutput, parseProbeOutput, ProbeResult } from './ffprobe.parser';
import { MediaProcessingError } from './media-processing.error';

const STDERR_LIMIT = 2000;

/**
 * Thin wrapper over the ffprobe/ffmpeg binaries (TD-05). Inputs are URLs:
 * FFmpeg reads them with HTTP range requests, so large sources are never
 * fully downloaded.
 */
@Injectable()
export class MediaService {
  async probe(url: string): Promise<ProbeResult> {
    const stdout = await this.run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);
    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout.toString('utf-8')) as FfprobeOutput;
    } catch {
      throw new MediaProcessingError('ffprobe returned invalid JSON');
    }
    return parseProbeOutput(parsed);
  }

  /** Returns a JPEG (width 640) of the frame at `atSeconds`. */
  async captureFrame(url: string, atSeconds: number): Promise<Buffer> {
    const frame = await this.run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      url,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:-2',
      '-q:v',
      '3',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (frame.length === 0) {
      throw new MediaProcessingError('ffmpeg produced no frame');
    }
    return frame;
  }

  private run(command: string, args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      const out: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf-8')).slice(-STDERR_LIMIT);
      });
      child.on('error', (err) =>
        reject(new MediaProcessingError(`${command} failed: ${err.message}`)),
      );
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(out));
        } else {
          reject(
            new MediaProcessingError(
              `${command} exited with ${code}: ${stderr.trim()}`,
            ),
          );
        }
      });
    });
  }
}
