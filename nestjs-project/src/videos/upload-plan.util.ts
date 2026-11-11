import { MAX_MULTIPART_PARTS } from './videos.constants';

export interface UploadPlan {
  partSize: number;
  partCount: number;
}

/** Fixed-size parts (TD-04); the last part carries the remainder. */
export function planParts(fileSize: number, partSize: number): UploadPlan {
  if (!Number.isInteger(fileSize) || fileSize < 1) {
    throw new RangeError('fileSize must be a positive integer');
  }
  const partCount = Math.ceil(fileSize / partSize);
  if (partCount > MAX_MULTIPART_PARTS) {
    throw new RangeError(
      `fileSize requires ${partCount} parts; the maximum is ${MAX_MULTIPART_PARTS}`,
    );
  }
  return { partSize, partCount };
}
