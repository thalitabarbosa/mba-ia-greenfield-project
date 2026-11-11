import { Job } from 'bullmq';
import { VideoProcessor } from './video.processor';

function makeJob(attemptsMade: number): Job {
  return {
    data: { videoId: 'v1' },
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job;
}

describe('VideoProcessor (unit)', () => {
  it('rethrows without marking failure before the last attempt', async () => {
    const processing = {
      process: jest.fn().mockRejectedValue(new Error('boom')),
      markFailed: jest.fn(),
    };
    const processor = new VideoProcessor(processing as any);

    await expect(processor.process(makeJob(0))).rejects.toThrow('boom');
    expect(processing.markFailed).not.toHaveBeenCalled();
  });

  it('marks the video as failed on the last attempt and rethrows', async () => {
    const processing = {
      process: jest.fn().mockRejectedValue(new Error('boom')),
      markFailed: jest.fn(),
    };
    const processor = new VideoProcessor(processing as any);

    await expect(processor.process(makeJob(2))).rejects.toThrow('boom');
    expect(processing.markFailed).toHaveBeenCalledWith('v1', 'boom');
  });
});
