import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { generateTestVideo } from '../test/video-fixture';
import {
  createChannelFixture,
  createVideoFixture,
  testTypeOrmOptions,
} from '../test/video-test.utils';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';
import { VideoStatus } from './video-status.enum';

describe('VideoProcessingService (integration, real DB + MinIO + ffmpeg)', () => {
  let moduleRef: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let fixture: Buffer;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(testTypeOrmOptions()),
        TypeOrmModule.forFeature([
          User,
          Channel,
          RefreshToken,
          VerificationToken,
          Video,
        ]),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingService],
    }).compile();
    service = moduleRef.get(VideoProcessingService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);
    fixture = generateTestVideo(3);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function reload(id: string): Promise<Video> {
    return dataSource.getRepository(Video).findOneByOrFail({ id });
  }

  it('marks a processing video ready with duration, metadata and thumbnail', async () => {
    const video = await createVideoFixture(
      dataSource,
      await createChannelFixture(dataSource),
    );
    await storage.putObject(video.storage_key, fixture, 'video/mp4');

    await service.process(video.id);

    const done = await reload(video.id);
    expect(done.status).toBe(VideoStatus.READY);
    expect(done.duration_seconds).toBeCloseTo(3, 0);
    expect(done.metadata).toMatchObject({ width: 320, height: 240 });
    expect(done.thumbnail_key).toBe(`thumbnails/${video.id}/thumbnail.jpg`);
    expect(done.processed_at).not.toBeNull();
    await expect(
      storage.getObjectSize(done.thumbnail_key!),
    ).resolves.toBeGreaterThan(0);
  });

  it('rejects a non-video source and markFailed sets error with a reason', async () => {
    const video = await createVideoFixture(
      dataSource,
      await createChannelFixture(dataSource),
    );
    await storage.putObject(
      video.storage_key,
      Buffer.from('nope'),
      'video/mp4',
    );

    await expect(service.process(video.id)).rejects.toThrow();
    await service.markFailed(video.id, 'ffprobe exited with 1');

    const failed = await reload(video.id);
    expect(failed.status).toBe(VideoStatus.ERROR);
    expect(failed.error_reason).toBe('ffprobe exited with 1');
  });

  it('is idempotent: a ready video is left untouched', async () => {
    const video = await createVideoFixture(
      dataSource,
      await createChannelFixture(dataSource),
      { status: VideoStatus.READY, duration_seconds: 42 },
    );

    await service.process(video.id);
    await service.markFailed(video.id, 'late failure');

    const same = await reload(video.id);
    expect(same.status).toBe(VideoStatus.READY);
    expect(same.duration_seconds).toBe(42);
  });
});
