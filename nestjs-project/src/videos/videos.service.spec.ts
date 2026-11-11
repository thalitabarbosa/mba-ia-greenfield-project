import { QueryFailedError } from 'typeorm';
import {
  UploadSizeMismatchException,
  VideoInvalidStatusException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const MIB = 1024 * 1024;

function makeVideo(overrides: Partial<Video> = {}): Video {
  return Object.assign(new Video(), {
    id: 'video-id',
    channel_id: 'channel-id',
    title: 'Title',
    slug: 'abcdefghijk',
    status: VideoStatus.DRAFT,
    original_file_name: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 6 * MIB,
    storage_key: 'videos/video-id/original',
    upload_id: 'upload-id',
    thumbnail_key: null,
    duration_seconds: null,
    metadata: null,
    error_reason: null,
    processed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });
}

function slugViolation(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = 'Key (slug)=(abc) already exists.';
  return err;
}

function setup() {
  const videos = {
    create: jest.fn((data: Partial<Video>) => makeVideo(data)),
    save: jest.fn(async (v: Video) => v),
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const channelsService = {
    findByUserId: jest.fn().mockResolvedValue({ id: 'channel-id' }),
  };
  const storage = {
    presignedUrlExpirationSeconds: 3600,
    createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
    presignUploadPart: jest.fn(
      async (_k: string, _u: string, n: number) => `url-${n}`,
    ),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    getObjectSize: jest.fn(),
    deleteObject: jest.fn(),
    presignGetObject: jest.fn().mockResolvedValue('signed-url'),
  };
  const producer = { enqueue: jest.fn() };
  const service = new VideosService(
    videos as any,
    channelsService as any,
    storage as any,
    producer as any,
    { maxFileSize: 10 * 1024 * MIB, partSize: 64 * MIB },
  );
  return { service, videos, storage, producer };
}

const initDto = {
  title: 'Title',
  fileName: 'clip.mp4',
  fileSize: 10 * 1024 * MIB,
  contentType: 'video/mp4',
};

describe('VideosService (unit)', () => {
  describe('initiateUpload', () => {
    it('creates a draft and returns one presigned URL per 64 MiB part', async () => {
      const { service, videos } = setup();

      const result = await service.initiateUpload('user-id', initDto);

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.upload.partCount).toBe(160);
      expect(result.upload.parts[159]).toEqual({
        partNumber: 160,
        url: 'url-160',
      });
      expect(videos.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.DRAFT,
          upload_id: 'upload-id',
        }),
      );
    });

    it('retries with a new slug on a slug unique violation', async () => {
      const { service, videos } = setup();
      videos.save
        .mockRejectedValueOnce(slugViolation())
        .mockImplementationOnce(async (v: Video) => v);

      await service.initiateUpload('user-id', initDto);

      expect(videos.save).toHaveBeenCalledTimes(2);
      const [first, second] = videos.create.mock.calls.map(
        ([data]) => data.slug,
      );
      expect(first).not.toBe(second);
    });

    it('aborts the multipart upload when the insert fails', async () => {
      const { service, videos, storage } = setup();
      videos.save.mockRejectedValue(new Error('db down'));

      await expect(service.initiateUpload('user-id', initDto)).rejects.toThrow(
        'db down',
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/original$/),
        'upload-id',
      );
    });
  });

  describe('completeUpload', () => {
    const parts = { parts: [{ partNumber: 1, etag: '"e"' }] };

    it('moves to processing and enqueues the job', async () => {
      const { service, videos, storage, producer } = setup();
      videos.findOne.mockResolvedValue(makeVideo());
      storage.getObjectSize.mockResolvedValue(6 * MIB);
      videos.findOneByOrFail.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      const result = await service.completeUpload('user-id', 'video-id', parts);

      expect(videos.update).toHaveBeenCalledWith('video-id', {
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      expect(producer.enqueue).toHaveBeenCalledWith('video-id');
      expect(result.status).toBe(VideoStatus.PROCESSING);
    });

    it('marks error and deletes the object on size mismatch', async () => {
      const { service, videos, storage, producer } = setup();
      videos.findOne.mockResolvedValue(makeVideo());
      storage.getObjectSize.mockResolvedValue(1);

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storage.deleteObject).toHaveBeenCalled();
      expect(videos.update).toHaveBeenCalledWith(
        'video-id',
        expect.objectContaining({
          status: VideoStatus.ERROR,
          error_reason: 'SIZE_MISMATCH',
        }),
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('marks ENQUEUE_FAILED and rethrows when the queue is unavailable', async () => {
      const { service, videos, storage, producer } = setup();
      videos.findOne.mockResolvedValue(makeVideo());
      storage.getObjectSize.mockResolvedValue(6 * MIB);
      producer.enqueue.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toThrow('redis down');
      expect(videos.update).toHaveBeenLastCalledWith('video-id', {
        status: VideoStatus.ERROR,
        error_reason: 'ENQUEUE_FAILED',
      });
    });

    it('rejects videos that are not drafts', async () => {
      const { service, videos } = setup();
      videos.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toBeInstanceOf(VideoInvalidStatusException);
    });

    it('hides videos of other channels as not found', async () => {
      const { service, videos } = setup();
      videos.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-id', 'video-id', parts),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('streaming', () => {
    it('refuses to stream a video that is not ready', async () => {
      const { service, videos } = setup();
      videos.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.getStreamUrl('user-id', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });

    it('signs a download URL with an attachment file name', async () => {
      const { service, videos, storage } = setup();
      videos.findOne.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );

      await service.getDownloadUrl('user-id', 'abcdefghijk');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-id/original',
        { audience: 'public', downloadFileName: 'Title.mp4' },
      );
    });
  });
});
