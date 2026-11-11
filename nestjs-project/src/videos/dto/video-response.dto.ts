import type { VideoMetadata } from '../video-metadata.types';
import { VideoStatus } from '../video-status.enum';
import type { Video } from '../entities/video.entity';

export class VideoResponseDto {
  id: string;
  /** Unique URL identifier (11 chars). */
  slug: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  metadata: VideoMetadata | null;
  errorReason: string | null;
  hasThumbnail: boolean;
  createdAt: Date;
  processedAt: Date | null;

  static fromEntity(video: Video): VideoResponseDto {
    const dto = new VideoResponseDto();
    dto.id = video.id;
    dto.slug = video.slug;
    dto.title = video.title;
    dto.status = video.status;
    dto.durationSeconds = video.duration_seconds;
    dto.metadata = video.metadata;
    dto.errorReason = video.error_reason;
    dto.hasThumbnail = video.thumbnail_key !== null;
    dto.createdAt = video.created_at;
    dto.processedAt = video.processed_at;
    return dto;
  }
}

export class UploadPartUrlDto {
  partNumber: number;
  url: string;
}

export class UploadInstructionsDto {
  partSize: number;
  partCount: number;
  /** Seconds until the part URLs expire. */
  expiresIn: number;
  parts: UploadPartUrlDto[];
}

export class InitiateUploadResponseDto {
  id: string;
  slug: string;
  status: VideoStatus;
  upload: UploadInstructionsDto;
}
