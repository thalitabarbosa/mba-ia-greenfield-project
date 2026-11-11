import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { putToPresignedUrl } from '../src/test/storage-test.utils';
import { generateTestVideo } from '../src/test/video-fixture';
import { waitFor } from '../src/test/video-test.utils';
import { Video } from '../src/videos/entities/video.entity';
import { VideoProcessingProducer } from '../src/videos/video-processing.producer';
import { VideoStatus } from '../src/videos/video-status.enum';

const MIB = 1024 * 1024;
const TEN_GIB = 10 * 1024 * MIB;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let userCounter = 0;

  beforeAll(async () => {
    // Small parts keep multi-part uploads cheap in tests (S3 minimum is 5 MiB).
    process.env.UPLOAD_PART_SIZE = String(5 * MIB);

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function loginNewUser(): Promise<string> {
    const email = `videos_e2e_${++userCounter}_${Date.now()}@example.com`;
    const password = 'password123';
    const mailService = (app.get(AuthService) as any).mailService;
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        token = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  function initUpload(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  /** Splits `file` according to the plan returned by init and PUTs every part. */
  async function uploadParts(
    upload: { partSize: number; parts: { partNumber: number; url: string }[] },
    file: Buffer,
  ) {
    return Promise.all(
      upload.parts.map(async ({ partNumber, url }) => {
        const start = (partNumber - 1) * upload.partSize;
        const body = file.subarray(start, start + upload.partSize);
        return { partNumber, etag: await putToPresignedUrl(url, body) };
      }),
    );
  }

  function complete(token: string, id: string, parts: unknown[]) {
    return request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts });
  }

  describe('POST /videos/uploads', () => {
    it('pre-registers a 10 GiB draft and returns one URL per part', async () => {
      const token = await loginNewUser();

      const res = await initUpload(token, {
        title: 'Big one',
        fileName: 'big.mp4',
        fileSize: TEN_GIB,
        contentType: 'video/mp4',
      }).expect(201);

      expect(res.body.status).toBe('draft');
      expect(res.body.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(res.body.upload.partSize).toBe(5 * MIB);
      expect(res.body.upload.partCount).toBe(2048);
      expect(res.body.upload.parts).toHaveLength(2048);

      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: res.body.id });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.upload_id).not.toBeNull();
    });

    it('rejects files above 10 GiB and non-video content types', async () => {
      const token = await loginNewUser();
      const base = { title: 't', fileName: 'a.mp4', contentType: 'video/mp4' };

      await initUpload(token, { ...base, fileSize: TEN_GIB + 1 }).expect(400);
      await initUpload(token, {
        ...base,
        fileSize: 10,
        contentType: 'image/png',
      }).expect(400);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({})
        .expect(401);
    });
  });

  describe('upload completion and abort', () => {
    const file = Buffer.alloc(6 * MIB, 1);

    async function startUpload(token: string, fileSize = file.length) {
      const res = await initUpload(token, {
        title: 'Clip',
        fileName: 'clip.mp4',
        fileSize,
        contentType: 'video/mp4',
      }).expect(201);
      return res.body as {
        id: string;
        slug: string;
        upload: {
          partSize: number;
          parts: { partNumber: number; url: string }[];
        };
      };
    }

    it('completes a 2-part upload, moves to processing and enqueues', async () => {
      const token = await loginNewUser();
      const enqueue = jest.spyOn(app.get(VideoProcessingProducer), 'enqueue');
      const init = await startUpload(token);
      expect(init.upload.parts).toHaveLength(2);

      const parts = await uploadParts(init.upload, file);
      const res = await complete(token, init.id, parts).expect(200);

      expect(res.body.status).toBe('processing');
      expect(enqueue).toHaveBeenCalledWith(init.id);
    });

    it('returns 422 UPLOAD_PARTS_INVALID for a wrong ETag', async () => {
      const token = await loginNewUser();
      const init = await startUpload(token);
      const parts = await uploadParts(init.upload, file);
      parts[0].etag = '"00000000000000000000000000000000"';

      const res = await complete(token, init.id, parts).expect(422);
      expect(res.body.error).toBe('UPLOAD_PARTS_INVALID');
    });

    it('returns 422 UPLOAD_SIZE_MISMATCH and marks error when sizes differ', async () => {
      const token = await loginNewUser();
      const init = await startUpload(token, file.length + 1);
      const parts = await uploadParts(init.upload, file);

      const res = await complete(token, init.id, parts).expect(422);
      expect(res.body.error).toBe('UPLOAD_SIZE_MISMATCH');
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: init.id });
      expect(row.status).toBe(VideoStatus.ERROR);
    });

    it('returns 409 on a second completion and 404 for another user', async () => {
      const token = await loginNewUser();
      const other = await loginNewUser();
      const init = await startUpload(token);
      const parts = await uploadParts(init.upload, file);

      const notOwner = await complete(other, init.id, parts).expect(404);
      expect(notOwner.body.error).toBe('VIDEO_NOT_FOUND');

      await complete(token, init.id, parts).expect(200);
      const again = await complete(token, init.id, parts).expect(409);
      expect(again.body.error).toBe('VIDEO_INVALID_STATUS');
    });

    it('aborts a draft (204) and refuses to abort a processing video (409)', async () => {
      const token = await loginNewUser();
      const draft = await startUpload(token);

      await request(app.getHttpServer())
        .delete(`/videos/${draft.id}/upload`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      await expect(
        dataSource.getRepository(Video).findOneBy({ id: draft.id }),
      ).resolves.toBeNull();

      const processing = await startUpload(token);
      await complete(
        token,
        processing.id,
        await uploadParts(processing.upload, file),
      ).expect(200);
      await request(app.getHttpServer())
        .delete(`/videos/${processing.id}/upload`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);
    });
  });

  describe('full pipeline: upload → worker → streaming and download', () => {
    it('processes a real video in the video-worker container and streams it', async () => {
      const token = await loginNewUser();
      const other = await loginNewUser();
      const video = generateTestVideo(3);
      const auth = { Authorization: `Bearer ${token}` };

      const init = await initUpload(token, {
        title: 'Pipeline',
        fileName: 'pipeline.mp4',
        fileSize: video.length,
        contentType: 'video/mp4',
      }).expect(201);
      const { id, slug, upload } = init.body;

      const notReady = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set(auth)
        .expect(409);
      expect(notReady.body.error).toBe('VIDEO_NOT_READY');

      await complete(token, id, await uploadParts(upload, video)).expect(200);

      const ready = await waitFor(
        async () =>
          (
            await request(app.getHttpServer())
              .get(`/videos/${slug}`)
              .set(auth)
              .expect(200)
          ).body,
        (body) => body.status !== 'processing',
        60_000,
        1_000,
      );
      expect(ready.status).toBe('ready');
      expect(ready.durationSeconds).toBeCloseTo(3, 0);
      expect(ready.metadata).toMatchObject({ width: 320, height: 240 });
      expect(ready.hasThumbnail).toBe(true);

      await request(app.getHttpServer())
        .get(`/videos/${slug}`)
        .set('Authorization', `Bearer ${other}`)
        .expect(404);

      const stream = await request(app.getHttpServer())
        .get(`/videos/${slug}/stream`)
        .set(auth)
        .expect(302);
      const partial = await fetch(stream.headers.location, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toMatch(
        new RegExp(`^bytes 0-1023/${video.length}$`),
      );

      const download = await request(app.getHttpServer())
        .get(`/videos/${slug}/download`)
        .set(auth)
        .expect(302);
      const file = await fetch(download.headers.location);
      expect(file.headers.get('content-disposition')).toBe(
        'attachment; filename="Pipeline.mp4"',
      );
      expect(Buffer.from(await file.arrayBuffer()).equals(video)).toBe(true);

      const thumb = await request(app.getHttpServer())
        .get(`/videos/${slug}/thumbnail`)
        .set(auth)
        .expect(302);
      const image = await fetch(thumb.headers.location);
      expect(image.headers.get('content-type')).toBe('image/jpeg');
    });
  });
});
