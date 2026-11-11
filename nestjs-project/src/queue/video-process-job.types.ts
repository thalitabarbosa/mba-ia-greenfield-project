/** Payload of the `video.process` job — the worker reads everything else from the DB. */
export interface VideoProcessJobData {
  videoId: string;
}
