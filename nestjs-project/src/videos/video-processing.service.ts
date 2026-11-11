import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { MediaService } from '../media/media.service';
import { thumbnailTimestamp } from '../media/thumbnail-time.util';
import { videoThumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { ERROR_REASON_MAX_LENGTH } from './videos.constants';

/**
 * Worker-side processing of an uploaded video (TD-05, TD-08, TD-11).
 * Every transition is conditional on `status = processing`, so duplicate
 * deliveries can never regress a finished video.
 */
@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videos.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Skipping video ${videoId}: status is ${video?.status ?? 'missing'}`,
      );
      return;
    }

    const sourceUrl = await this.storage.presignGetObject(video.storage_key, {
      audience: 'internal',
    });
    const probe = await this.media.probe(sourceUrl);
    const frame = await this.media.captureFrame(
      sourceUrl,
      thumbnailTimestamp(probe.durationSeconds),
    );

    const thumbnailKey = videoThumbnailKey(video.id);
    await this.storage.putObject(thumbnailKey, frame, 'image/jpeg');

    await this.transitionFromProcessing(video.id, {
      status: VideoStatus.READY,
      duration_seconds: probe.durationSeconds,
      metadata: probe.metadata,
      thumbnail_key: thumbnailKey,
      processed_at: new Date(),
      error_reason: null,
    });
    this.logger.log(`Video ${video.id} is ready`);
  }

  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.transitionFromProcessing(videoId, {
      status: VideoStatus.ERROR,
      error_reason: reason.slice(0, ERROR_REASON_MAX_LENGTH),
    });
    this.logger.warn(`Video ${videoId} failed: ${reason}`);
  }

  private async transitionFromProcessing(
    videoId: string,
    changes: QueryDeepPartialEntity<Video>,
  ): Promise<void> {
    await this.videos
      .createQueryBuilder()
      .update(Video)
      .set(changes)
      .where('id = :id AND status = :status', {
        id: videoId,
        status: VideoStatus.PROCESSING,
      })
      .execute();
  }
}
