import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './queue.constants';

const videoProcessingQueue = BullModule.registerQueue({
  name: VIDEO_PROCESSING_QUEUE,
});

/** Redis connection + the `video-processing` queue, shared by API and worker. */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.redisHost, port: cfg.redisPort },
      }),
    }),
    videoProcessingQueue,
  ],
  exports: [videoProcessingQueue],
})
export class QueueModule {}
