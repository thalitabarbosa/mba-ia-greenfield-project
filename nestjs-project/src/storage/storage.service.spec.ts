import { S3Client } from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(
    async (client: { tag: string }) => `signed-by-${client.tag}`,
  ),
}));

describe('StorageService (unit)', () => {
  const internalClient = { tag: 'internal' } as unknown as S3Client;
  const publicClient = { tag: 'public' } as unknown as S3Client;
  const config = {
    endpoint: 'http://minio:9000',
    publicEndpoint: 'http://localhost:9000',
    region: 'us-east-1',
    accessKey: 'a',
    secretKey: 'b',
    bucket: 'streamtube',
    presignedUrlExpirationSeconds: 3600,
  };
  const service = new StorageService(internalClient, publicClient, config);

  it('signs client-facing GET URLs with the public client', async () => {
    await expect(
      service.presignGetObject('k', { audience: 'public' }),
    ).resolves.toBe('signed-by-public');
  });

  it('signs GET URLs consumed inside Docker with the internal client', async () => {
    await expect(
      service.presignGetObject('k', { audience: 'internal' }),
    ).resolves.toBe('signed-by-internal');
  });

  it('signs upload part URLs with the public client', async () => {
    await expect(service.presignUploadPart('k', 'u', 1)).resolves.toBe(
      'signed-by-public',
    );
  });
});
