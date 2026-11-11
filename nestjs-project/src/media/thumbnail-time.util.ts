const MAX_THUMBNAIL_OFFSET_SECONDS = 10;
const THUMBNAIL_RATIO = 0.1;

/** TD-05 R1: 10% into the video, capped at 10 s; 0 for < 1 s or unknown. */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (durationSeconds === null || durationSeconds < 1) return 0;
  return Math.min(
    durationSeconds * THUMBNAIL_RATIO,
    MAX_THUMBNAIL_OFFSET_SECONDS,
  );
}
