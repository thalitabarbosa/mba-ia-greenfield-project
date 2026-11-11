import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

/**
 * Boots the exact module the `video-worker` container runs, so a missing
 * entity or provider fails here instead of only at container start.
 */
describe('WorkerModule (integration)', () => {
  it('initializes against the real DB with the Video relations resolved', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await moduleRef.init();

    const dataSource = moduleRef.get(DataSource);
    expect(dataSource.isInitialized).toBe(true);
    expect(
      dataSource.getMetadata(Video).relations.map((r) => r.propertyName),
    ).toContain('channel');

    await moduleRef.close();
  });
});
