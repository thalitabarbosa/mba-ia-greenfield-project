import { randomUUID } from 'node:crypto';
import { StorageService } from '../storage/storage.service';
import { createRealStorageService } from '../test/storage-test.utils';
import { generateTestVideo } from '../test/video-fixture';
import { MediaProcessingError } from './media-processing.error';
import { MediaService } from './media.service';

describe('MediaService (integration, real ffmpeg + MinIO)', () => {
  const media = new MediaService();
  let storage: StorageService;
  const videoKey = `test/${randomUUID()}.mp4`;
  const textKey = `test/${randomUUID()}.txt`;

  beforeAll(async () => {
    storage = await createRealStorageService();
    await storage.putObject(videoKey, generateTestVideo(3), 'video/mp4');
    await storage.putObject(textKey, Buffer.from('not a video'), 'text/plain');
  });

  afterAll(async () => {
    await storage.deleteObject(videoKey);
    await storage.deleteObject(textKey);
  });

  function internalUrl(key: string): Promise<string> {
    return storage.presignGetObject(key, { audience: 'internal' });
  }

  it('probes duration and metadata through a presigned URL', async () => {
    const result = await media.probe(await internalUrl(videoKey));

    expect(result.durationSeconds).toBeCloseTo(3, 0);
    expect(result.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
      frameRate: 25,
    });
  });

  it('captures a JPEG frame', async () => {
    const frame = await media.captureFrame(await internalUrl(videoKey), 0.3);

    expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('fails with MediaProcessingError for a non-video file', async () => {
    await expect(media.probe(await internalUrl(textKey))).rejects.toBeInstanceOf(
      MediaProcessingError,
    );
  });
});
