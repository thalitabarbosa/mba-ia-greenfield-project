import type { VideoMetadata } from '../videos/video-metadata.types';
import { MediaProcessingError, NO_VIDEO_STREAM } from './media-processing.error';

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeFormat {
  format_name?: string;
  duration?: string;
  bit_rate?: string;
  size?: string;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export interface ProbeResult {
  durationSeconds: number | null;
  metadata: VideoMetadata;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === 'N/A') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "30000/1001" → 29.97; "0/0" → null. */
export function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split('/').map(Number);
  if (!den || !Number.isFinite(num) || num === 0) return null;
  return Math.round((num / den) * 100) / 100;
}

export function parseProbeOutput(output: FfprobeOutput): ProbeResult {
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) {
    throw new MediaProcessingError(NO_VIDEO_STREAM);
  }
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = output.format ?? {};

  return {
    durationSeconds: toNumber(format.duration) ?? toNumber(video.duration),
    metadata: {
      width: video.width ?? 0,
      height: video.height ?? 0,
      videoCodec: video.codec_name ?? 'unknown',
      audioCodec: audio?.codec_name ?? null,
      bitRate: toNumber(format.bit_rate),
      frameRate:
        parseFrameRate(video.avg_frame_rate) ??
        parseFrameRate(video.r_frame_rate),
      formatName: format.format_name ?? 'unknown',
      sizeBytes: toNumber(format.size) ?? 0,
    },
  };
}
