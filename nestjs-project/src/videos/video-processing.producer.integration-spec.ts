import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { testBullRoot } from '../test/queue-test.utils';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration, real Redis)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        testBullRoot(),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();
    producer = moduleRef.get(VideoProcessingProducer);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  it('enqueues video.process with the video id as job id and 3 attempts', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job?.name).toBe('video.process');
    expect(job?.data).toEqual({ videoId });
    expect(job?.opts.attempts).toBe(3);
  });

  it('ignores a duplicate enqueue for the same video', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    const waiting = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(waiting.filter((j) => j.id === videoId)).toHaveLength(1);
  });
});
