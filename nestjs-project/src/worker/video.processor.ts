import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import type { VideoProcessJobData } from '../queue/video-process-job.types';
import { VideoProcessingService } from '../videos/video-processing.service';
import { isFinalAttempt } from './final-attempt.util';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId } = job.data;
    try {
      await this.processing.process(videoId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Attempt ${job.attemptsMade + 1} for video ${videoId} failed: ${message}`,
      );
      if (isFinalAttempt(job.attemptsMade, job.opts.attempts)) {
        await this.processing.markFailed(videoId, message);
      }
      throw err; // lets BullMQ record the failure and schedule the retry
    }
  }
}
