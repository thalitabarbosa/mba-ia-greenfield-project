import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { generateVideoSlug } from '../videos/slug.util';
import { VideoStatus } from '../videos/video-status.enum';
import { videoOriginalKey } from '../storage/storage-keys';

export async function createChannelFixture(
  dataSource: DataSource,
): Promise<Channel> {
  const suffix = randomUUID().slice(0, 8);
  const user = await dataSource.getRepository(User).save({
    email: `video_${suffix}@example.com`,
    password: 'hashed',
  });
  return dataSource.getRepository(Channel).save({
    name: 'chan',
    nickname: `chan_${suffix}`,
    user_id: user.id,
  });
}

export async function createVideoFixture(
  dataSource: DataSource,
  channel: Channel,
  overrides: Partial<Video> = {},
): Promise<Video> {
  const id = randomUUID();
  const repo = dataSource.getRepository(Video);
  return repo.save(
    repo.create({
      id,
      channel_id: channel.id,
      title: 'Fixture video',
      slug: generateVideoSlug(),
      status: VideoStatus.PROCESSING,
      original_file_name: 'fixture.mp4',
      content_type: 'video/mp4',
      size_bytes: 1,
      storage_key: videoOriginalKey(id),
      upload_id: null,
      ...overrides,
    }),
  );
}

export function testTypeOrmOptions() {
  return {
    type: 'postgres' as const,
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_NAME ?? 'streamtube',
    autoLoadEntities: true,
    synchronize: false,
  };
}

export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
