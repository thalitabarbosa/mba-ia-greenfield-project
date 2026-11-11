/** Raised by the FFmpeg wrapper; consumed only by the worker (not an HTTP error). */
export class MediaProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProcessingError';
  }
}

export const NO_VIDEO_STREAM = 'NO_VIDEO_STREAM';
