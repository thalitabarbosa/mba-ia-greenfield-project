/**
 * Upload/processing state of a video (TD-08 R1). Publication and visibility
 * are owned by Phase 04 and are not encoded here.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  ERROR = 'error',
}
