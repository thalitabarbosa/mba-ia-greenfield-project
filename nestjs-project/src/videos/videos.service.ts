import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ThumbnailNotFoundException,
  UploadSizeMismatchException,
  VideoInvalidStatusException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import uploadConfig from '../config/upload.config';
import { videoOriginalKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { buildDownloadFileName } from './download-file-name.util';
import {
  InitiateUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import { planParts } from './upload-plan.util';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideoStatus } from './video-status.enum';
import {
  ERROR_REASON_ENQUEUE_FAILED,
  ERROR_REASON_SIZE_MISMATCH,
  PG_UNIQUE_VIOLATION,
  SLUG_MAX_ATTEMPTS,
} from './videos.constants';

function isSlugUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: string; detail?: string };
  return e.code === PG_UNIQUE_VIOLATION && !!e.detail?.includes('(slug)');
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly producer: VideoProcessingProducer,
    @Inject(uploadConfig.KEY)
    private readonly upload: ConfigType<typeof uploadConfig>,
  ) {}

  /** Pre-registers the video as draft and opens a direct-to-storage multipart upload (TD-03, TD-08). */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    const plan = planParts(dto.fileSize, this.upload.partSize);

    const id = randomUUID();
    const storageKey = videoOriginalKey(id);
    const uploadId = await this.storage.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    let video: Video;
    try {
      video = await this.insertWithUniqueSlug({
        id,
        channel_id: channel.id,
        title: dto.title,
        status: VideoStatus.DRAFT,
        original_file_name: dto.fileName,
        content_type: dto.contentType,
        size_bytes: dto.fileSize,
        storage_key: storageKey,
        upload_id: uploadId,
      });
    } catch (err) {
      await this.storage.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    const parts = await Promise.all(
      Array.from({ length: plan.partCount }, async (_, i) => ({
        partNumber: i + 1,
        url: await this.storage.presignUploadPart(storageKey, uploadId, i + 1),
      })),
    );

    return {
      id: video.id,
      slug: video.slug,
      status: video.status,
      upload: {
        partSize: plan.partSize,
        partCount: plan.partCount,
        expiresIn: this.storage.presignedUrlExpirationSeconds,
        parts,
      },
    };
  }

  /** Finalizes the multipart upload, verifies the size and hands the video to the worker (TD-04, TD-08). */
  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedById(userId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoInvalidStatusException();
    }

    await this.storage.completeMultipartUpload(
      video.storage_key,
      video.upload_id,
      dto.parts,
    );

    const actualSize = await this.storage.getObjectSize(video.storage_key);
    if (actualSize !== video.size_bytes) {
      await this.storage.deleteObject(video.storage_key);
      await this.videos.update(video.id, {
        status: VideoStatus.ERROR,
        upload_id: null,
        error_reason: ERROR_REASON_SIZE_MISMATCH,
      });
      throw new UploadSizeMismatchException();
    }

    await this.videos.update(video.id, {
      status: VideoStatus.PROCESSING,
      upload_id: null,
    });

    try {
      await this.producer.enqueue(video.id);
    } catch (err) {
      await this.videos.update(video.id, {
        status: VideoStatus.ERROR,
        error_reason: ERROR_REASON_ENQUEUE_FAILED,
      });
      throw err;
    }

    return VideoResponseDto.fromEntity(
      await this.videos.findOneByOrFail({ id: video.id }),
    );
  }

  /** Cancels a draft upload: frees storage parts and removes the pre-registration. */
  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedById(userId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoInvalidStatusException();
    }
    await this.storage.abortMultipartUpload(video.storage_key, video.upload_id);
    await this.videos.delete({ id: video.id });
  }

  async getOwnedBySlug(userId: string, slug: string): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = await this.videos.findOne({
      where: { slug, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async getDetails(userId: string, slug: string): Promise<VideoResponseDto> {
    return VideoResponseDto.fromEntity(await this.getOwnedBySlug(userId, slug));
  }

  /** Presigned inline URL; storage serves Range/206 (TD-07). */
  async getStreamUrl(userId: string, slug: string): Promise<string> {
    const video = this.assertReady(await this.getOwnedBySlug(userId, slug));
    return this.storage.presignGetObject(video.storage_key, {
      audience: 'public',
    });
  }

  async getDownloadUrl(userId: string, slug: string): Promise<string> {
    const video = this.assertReady(await this.getOwnedBySlug(userId, slug));
    return this.storage.presignGetObject(video.storage_key, {
      audience: 'public',
      downloadFileName: buildDownloadFileName(
        video.title,
        video.original_file_name,
      ),
    });
  }

  async getThumbnailUrl(userId: string, slug: string): Promise<string> {
    const video = await this.getOwnedBySlug(userId, slug);
    if (!video.thumbnail_key) {
      throw new ThumbnailNotFoundException();
    }
    return this.storage.presignGetObject(video.thumbnail_key, {
      audience: 'public',
    });
  }

  private async findOwnedById(userId: string, videoId: string): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    const video = await this.videos.findOne({
      where: { id: videoId, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private assertReady(video: Video): Video {
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async insertWithUniqueSlug(data: Partial<Video>): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videos.save(
          this.videos.create({ ...data, slug: generateVideoSlug() }),
        );
      } catch (err) {
        if (!isSlugUniqueViolation(err) || attempt >= SLUG_MAX_ATTEMPTS) {
          throw err;
        }
      }
    }
  }
}
