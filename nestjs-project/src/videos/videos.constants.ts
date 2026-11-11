export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

/** Hard ceiling of the S3 multipart protocol. */
export const MAX_MULTIPART_PARTS = 10_000;

/** 10 GiB — upper bound accepted by the init DTO (TD-04). */
export const MAX_VIDEO_FILE_SIZE = 10 * 1024 * 1024 * 1024;

export const SLUG_MAX_ATTEMPTS = 3;
export const PG_UNIQUE_VIOLATION = '23505';

export const ERROR_REASON_MAX_LENGTH = 255;
export const ERROR_REASON_SIZE_MISMATCH = 'SIZE_MISMATCH';
export const ERROR_REASON_ENQUEUE_FAILED = 'ENQUEUE_FAILED';
