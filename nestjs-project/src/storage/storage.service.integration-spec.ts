import { randomUUID } from 'node:crypto';
import { UploadPartsInvalidException } from '../common/exceptions/domain.exception';
import {
  createRealStorageService,
  putToPresignedUrl,
} from '../test/storage-test.utils';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;

describe('StorageService (integration, real MinIO)', () => {
  let storage: StorageService;

  beforeAll(async () => {
    storage = await createRealStorageService();
  });

  async function uploadTwoParts(key: string) {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const part1 = Buffer.alloc(5 * MIB, 1);
    const part2 = Buffer.alloc(1024, 2);
    const etag1 = await putToPresignedUrl(
      await storage.presignUploadPart(key, uploadId, 1),
      part1,
    );
    const etag2 = await putToPresignedUrl(
      await storage.presignUploadPart(key, uploadId, 2),
      part2,
    );
    return {
      uploadId,
      parts: [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ],
      totalSize: part1.length + part2.length,
    };
  }

  it('completes a 2-part presigned multipart upload with the exact size', async () => {
    const key = `test/${randomUUID()}`;
    const { uploadId, parts, totalSize } = await uploadTwoParts(key);

    await storage.completeMultipartUpload(key, uploadId, parts);

    await expect(storage.getObjectSize(key)).resolves.toBe(totalSize);
    await storage.deleteObject(key);
  });

  it('serves Range requests with 206 through a presigned GET URL', async () => {
    const key = `test/${randomUUID()}`;
    await storage.putObject(key, Buffer.alloc(1000, 7), 'video/mp4');

    const url = await storage.presignGetObject(key, { audience: 'public' });
    const res = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    await storage.deleteObject(key);
  });

  it('adds Content-Disposition attachment when a download name is given', async () => {
    const key = `test/${randomUUID()}`;
    await storage.putObject(key, Buffer.from('x'), 'video/mp4');

    const url = await storage.presignGetObject(key, {
      audience: 'public',
      downloadFileName: 'my-video.mp4',
    });
    const res = await fetch(url);

    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="my-video.mp4"',
    );
    await storage.deleteObject(key);
  });

  it('throws UploadPartsInvalidException when an ETag is wrong', async () => {
    const key = `test/${randomUUID()}`;
    const { uploadId, parts } = await uploadTwoParts(key);
    parts[0].etag = '"00000000000000000000000000000000"';

    await expect(
      storage.completeMultipartUpload(key, uploadId, parts),
    ).rejects.toBeInstanceOf(UploadPartsInvalidException);
    await storage.abortMultipartUpload(key, uploadId);
  });

  it('makes an aborted upload id unusable', async () => {
    const key = `test/${randomUUID()}`;
    const { uploadId, parts } = await uploadTwoParts(key);

    await storage.abortMultipartUpload(key, uploadId);

    await expect(
      storage.completeMultipartUpload(key, uploadId, parts),
    ).rejects.toBeInstanceOf(UploadPartsInvalidException);
  });
});
