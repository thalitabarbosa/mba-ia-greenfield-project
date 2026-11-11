import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';

/** Boots a real StorageService against the Compose MinIO. */
export async function createRealStorageService(): Promise<StorageService> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  }).compile();
  return moduleRef.get(StorageService);
}

/** PUTs a body to a presigned URL and returns the ETag, as a browser would. */
export async function putToPresignedUrl(
  url: string,
  body: Buffer,
): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: Uint8Array.from(body) });
  if (!res.ok) {
    throw new Error(`PUT failed with ${res.status}: ${await res.text()}`);
  }
  const etag = res.headers.get('etag');
  if (!etag) throw new Error('Storage response has no ETag header');
  return etag;
}
