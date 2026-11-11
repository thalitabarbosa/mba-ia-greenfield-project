import { BullModule } from '@nestjs/bullmq';

/**
 * Isolated BullMQ root for tests: a unique key prefix keeps test jobs away
 * from the `video-worker` container, which consumes the default prefix.
 */
export function testBullRoot(prefix = `test-${process.pid}-${Date.now()}`) {
  return BullModule.forRoot({
    connection: {
      host: process.env.REDIS_HOST ?? 'redis',
      port: Number(process.env.REDIS_PORT ?? 6379),
    },
    prefix,
  });
}
