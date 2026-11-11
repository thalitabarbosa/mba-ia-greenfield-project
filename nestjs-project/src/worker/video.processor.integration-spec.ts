import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { MediaModule } from '../media/media.module';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { testBullRoot } from '../test/queue-test.utils';
import { generateTestVideo } from '../test/video-fixture';
import {
  createChannelFixture,
  createVideoFixture,
  testTypeOrmOptions,
  waitFor,
} from '../test/video-test.utils';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingProducer } from '../videos/video-processing.producer';
import { VideoProcessingService } from '../videos/video-processing.service';
import { VideoStatus } from '../videos/video-status.enum';
import { VideoProcessor } from './video.processor';

describe('VideoProcessor (integration, real Redis queue → worker)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;

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
        testBullRoot(),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessingService, VideoProcessor, VideoProcessingProducer],
    }).compile();
    await moduleRef.init(); // registers the BullMQ Worker for @Processor
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('consumes an enqueued job and marks the video ready', async () => {
    const video = await createVideoFixture(
      dataSource,
      await createChannelFixture(dataSource),
    );
    await moduleRef
      .get(StorageService)
      .putObject(video.storage_key, generateTestVideo(2), 'video/mp4');

    await moduleRef.get(VideoProcessingProducer).enqueue(video.id);

    const done = await waitFor(
      () => dataSource.getRepository(Video).findOneByOrFail({ id: video.id }),
      (v) => v.status !== VideoStatus.PROCESSING,
    );
    expect(done.status).toBe(VideoStatus.READY);
    expect(done.thumbnail_key).not.toBeNull();
  });
});
