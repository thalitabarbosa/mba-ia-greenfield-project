/** Curated metadata persisted in `videos.metadata` (TD-11). */
export interface VideoMetadata {
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  bitRate: number | null;
  frameRate: number | null;
  formatName: string;
  sizeBytes: number;
}
