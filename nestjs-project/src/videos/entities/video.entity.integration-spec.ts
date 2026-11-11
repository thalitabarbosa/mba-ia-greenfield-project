import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `video_entity_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'chan',
      nickname: `video_chan_${counter}`,
      user_id: user.id,
    });
  });

  function buildVideo(overrides: Partial<Video> = {}): Video {
    const id = randomUUID();
    return videos.create({
      id,
      channel_id: channel.id,
      title: 'My video',
      slug: `s${counter}${Math.random().toString(36).slice(2, 8)}`,
      original_file_name: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 10737418240,
      storage_key: `videos/${id}/original`,
      ...overrides,
    });
  }

  it('defaults status to draft and keeps a 10 GiB size as a number', async () => {
    const saved = await videos.save(buildVideo());
    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.size_bytes).toBe(10737418240);
  });

  it('enforces a unique slug', async () => {
    await videos.save(buildVideo({ slug: 'dupslug0001' }));

    await expect(
      videos.save(buildVideo({ slug: 'dupslug0001' })),
    ).rejects.toThrow();
  });

  it('round-trips metadata as JSON and duration with 3 decimals', async () => {
    const metadata = {
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: null,
      bitRate: 5_000_000,
      frameRate: 29.97,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      sizeBytes: 123,
    };
    const saved = await videos.save(
      buildVideo({ metadata, duration_seconds: 12.3456 }),
    );
    const found = await videos.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
    expect(found.duration_seconds).toBe(12.346);
  });

  it('cascades deletion from the owning channel', async () => {
    const saved = await videos.save(buildVideo());

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    await expect(videos.findOneBy({ id: saved.id })).resolves.toBeNull();
  });
});
