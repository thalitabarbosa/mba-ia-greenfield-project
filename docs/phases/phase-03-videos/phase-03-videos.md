---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-11T08:40:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T09:20:00-03:00"
  docs/phases/phase-03-videos/context.md: "2026-11-11T09:25:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-11T09:20:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of files up to 10GB directly to object storage (presigned S3 multipart, the API never carries the bytes), automatic draft pre-registration, background processing by a dedicated FFmpeg worker fed by a BullMQ/Redis queue (duration, metadata, thumbnail), a unique short URL per video, and owner-only streaming (HTTP Range via presigned URLs) and download — with MinIO, Redis and the worker running in Docker Compose next to the API.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces and Compose Infrastructure

**Description:** Install the Phase 03 libraries, add `storage`, `queue` and `upload` config namespaces with Joi validation, install FFmpeg in the dev image, and add `minio`, `minio-init`, `redis` and `video-worker` to Compose. (TD-01, TD-02, TD-04, TD-05, TD-10)

**Technical actions:**

- Confirm APIs with context7 for the exact installed versions (ADV-1), then install in `nestjs-project`: `@nestjs/bullmq@^11.0.4`, `bullmq@^5.76.0`, `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`.
- `src/config/storage.config.ts` — `registerAs('storage', ...)`: `endpoint` (`S3_ENDPOINT`, default `http://minio:9000`), `publicEndpoint` (`S3_PUBLIC_ENDPOINT`, default `http://localhost:9000`), `region` (`S3_REGION`, default `us-east-1`), `accessKey` (`S3_ACCESS_KEY`), `secretKey` (`S3_SECRET_KEY`), `bucket` (`S3_BUCKET`, default `streamtube`), `presignedUrlExpirationSeconds` (`PRESIGNED_URL_EXPIRATION_SECONDS`, default `3600`).
- `src/config/queue.config.ts` — `registerAs('queue', ...)`: `redisHost` (`REDIS_HOST`, default `redis`), `redisPort` (`REDIS_PORT`, default `6379`).
- `src/config/upload.config.ts` — `registerAs('upload', ...)`: `maxFileSize` (`UPLOAD_MAX_FILE_SIZE`, default `10737418240`), `partSize` (`UPLOAD_PART_SIZE`, default `67108864`).
- Extend `env.validation.ts`: `S3_ACCESS_KEY`/`S3_SECRET_KEY` required; the others with the defaults above; `UPLOAD_PART_SIZE` min `5242880`. Register the three factories in `AppModule` `load`. Update `.env.example`.
- `Dockerfile.dev`: add `ffmpeg` to the `apt install` line.
- `compose.yaml`: add `minio` (`minio/minio`, `server /data --console-address :9001`, ports 9000/9001, healthcheck, named volume), `minio-init` (`minio/mc`, creates bucket `streamtube`, exits 0); browser CORS is enabled server-wide on `minio` with `MINIO_API_CORS_ALLOW_ORIGIN=*` (MinIO has no per-bucket CORS API), `redis` (`redis:7-alpine`, `--appendonly yes`, healthcheck `redis-cli ping`), `video-worker` (same build/volume as `nestjs-api`; waits for `node_modules`, then `npm run start:worker`). `nestjs-api` and `video-worker` depend on `db` (healthy), `redis` (healthy), `minio` (healthy), `minio-init` (`service_completed_successfully`).
- `package.json`: scripts `start:worker` (`ts-node -r tsconfig-paths/register src/worker.ts` — avoids two `nest start --watch` processes deleting the shared `dist/`) and `start:worker:prod` (`node dist/worker`).
- Jest: add `src/test/jest-setup-env.ts` to `setupFiles` of both configs (forces `S3_PUBLIC_ENDPOINT=http://minio:9000` in tests, TD-02 R1).

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `db`, `mailpit`, `minio`, `redis`, `nestjs-api` and `video-worker`; `minio-init` exits 0 and bucket `streamtube` exists.
- `docker compose exec nestjs-api ffprobe -version` succeeds.
- Joi rejects a missing `S3_ACCESS_KEY` and an `UPLOAD_PART_SIZE` below 5 MiB; defaults apply when optional keys are absent (`env.validation.integration-spec.ts`).

---

### SI-03.2 — Storage Module (S3/MinIO Adapter)

**Description:** A `StorageModule` exposing `StorageService`, the only place that talks to S3. Two `S3Client`s: internal (server-side calls and URLs consumed inside Docker) and public (URLs handed to clients). (TD-02 + R1, TD-03, TD-07)

**Technical actions:**

- `src/storage/storage.module.ts`, `src/storage/storage.service.ts`, `src/storage/storage.constants.ts` (`STORAGE_INTERNAL_CLIENT`, `STORAGE_PUBLIC_CLIENT` provider tokens), `src/storage/storage.types.ts`.
- `StorageService` methods: `createMultipartUpload(key, contentType): Promise<string>`; `presignUploadPart(key, uploadId, partNumber): Promise<string>` (public client); `completeMultipartUpload(key, uploadId, parts)`; `abortMultipartUpload(key, uploadId)`; `getObjectSize(key): Promise<number>` (HeadObject); `presignGetObject(key, { audience: 'public' | 'internal', downloadFileName?: string }): Promise<string>`; `putObject(key, body, contentType)`; `deleteObject(key)`.
- Map S3 `NoSuchUpload`, `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall` to `UploadPartsInvalidException` (domain); other errors propagate.
- Key helpers in `src/storage/storage-keys.ts`: `videoOriginalKey(videoId) = videos/{id}/original`, `videoThumbnailKey(videoId) = thumbnails/{id}/thumbnail.jpg`.

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Integration (real MinIO): a 2-part multipart upload (5 MiB + 1 KiB) through presigned part URLs completes and `getObjectSize` returns the exact byte count.
- Integration: presigned GET with `downloadFileName` returns `Content-Disposition: attachment; filename="..."`; a request with `Range: bytes=0-99` returns `206` with 100 bytes.
- Integration: completing with a wrong ETag throws `UploadPartsInvalidException`; abort makes the upload id unusable.
- Unit: key helpers and the public/internal client selection.

---

### SI-03.3 — Video Entity, Migration and Slug Generation

**Description:** The `videos` table owned by a channel, with status lifecycle, storage keys, metadata and the unique slug. (TD-06, TD-08 + R1, TD-11)

**Technical actions:**

- `src/videos/entities/video.entity.ts` per Data Model; `src/videos/video-status.enum.ts` (`draft | processing | ready | error`); `src/videos/video-metadata.types.ts` (`VideoMetadata` interface).
- `src/videos/slug.util.ts` — `generateVideoSlug()`: `randomBytes(8).toString('base64url')` (11 chars, `[A-Za-z0-9_-]`).
- Migration `src/database/migrations/<timestamp>-CreateVideos.ts` generated with `npm run migration:generate` (enum type, table, unique index on `slug`, index on `channel_id`, FK `channel_id → channels.id ON DELETE CASCADE`).
- Relation is unidirectional (`Video` → `Channel`): an inverse `@OneToMany` on `Channel` would force every existing Phase 02 test DataSource to register `Video`.
- `src/test/create-test-data-source.ts` → `cleanAllTables` deletes `videos` first (FK order).
- `src/database/migrations.integration-spec.ts`: include the new migration class.

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Integration: inserting two videos with the same slug fails (unique); deleting a channel cascades to its videos; `metadata` round-trips as JSON; `duration_seconds` stores 3 decimals.
- Migration integration test applies and reverts `CreateVideos` cleanly.
- Unit: `generateVideoSlug()` returns 11 URL-safe chars; 10k generations have no duplicates.

---

### SI-03.4 — Upload Initiation (Draft Pre-registration + Multipart Plan)

**Description:** `POST /videos/uploads` creates the draft video and opens the multipart upload, returning one presigned URL per part. (TD-03, TD-04, TD-06, TD-08)

**Technical actions:**

- `ChannelsService.findByUserId(userId): Promise<Channel>` (throws `ChannelNotFoundException`) — channel lookup stays in `ChannelsModule`.
- `src/videos/upload-plan.util.ts` — `planParts(fileSize, partSize): { partSize, partCount }` (rejects `partCount > 10000`).
- `src/videos/dto/initiate-upload.dto.ts` — `title` (string, 1–100), `fileName` (string, 1–255), `fileSize` (int, 1 … 10737418240), `contentType` (`@IsIn([...ALLOWED_VIDEO_CONTENT_TYPES])`).
- `VideosService.initiateUpload(userId, dto)`: resolve channel → `id = randomUUID()` → `createMultipartUpload(videoOriginalKey(id))` → insert row (`status=draft`, `upload_id`, slug with retry ≤3 on `23505` for `slug` — single autocommit insert per attempt, so no SAVEPOINT is needed) → if insert fails, `abortMultipartUpload` and re-throw → presign all part URLs.
- `src/videos/videos.controller.ts` (`@Controller('videos')`, `@ApiTags('videos')`, `@ApiBearerAuth`), `src/videos/videos.module.ts` (imports `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`), registered in `AppModule`.

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- E2E (suite runs with `UPLOAD_PART_SIZE=5 MiB`): authenticated `POST /videos/uploads` for 10 GiB returns `201` with one URL per part (`partCount = 2048`), `status = draft`; the DB row exists with `status=draft` and `upload_id` set. Unit: default 64 MiB parts → `partCount = 160`.
- E2E: `fileSize = 10737418241` → `400 VALIDATION_ERROR`; `contentType = image/png` → `400`; no token → `401`.
- Unit: `planParts` boundaries (exact multiple, remainder, 1 byte); service aborts the multipart when the insert fails.
- Integration: slug collision on insert is retried and a different slug is persisted.

---

### SI-03.5 — Processing Queue Producer

**Description:** BullMQ registration and the producer that publishes `video.process`. (TD-01, TD-08)

**Technical actions:**

- `src/queue/queue.module.ts` — `BullModule.forRootAsync` from `queueConfig`; `src/queue/queue.constants.ts`: `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_PROCESS_JOB = 'video.process'`, `VIDEO_PROCESS_JOB_OPTIONS` (`attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: true`, `removeOnFail: false`); `src/queue/video-process-job.types.ts` (`VideoProcessJobData { videoId: string }`).
- `src/videos/video-processing.producer.ts` — `enqueue(videoId)`: `queue.add(VIDEO_PROCESS_JOB, { videoId }, { ...VIDEO_PROCESS_JOB_OPTIONS, jobId: videoId })`.
- `VideosModule` imports `QueueModule` + `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`.

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Integration (real Redis): `enqueue(id)` creates job `id` with payload `{ videoId: id }` and `attempts = 3`; enqueuing the same id twice leaves one job.

---

### SI-03.6 — Upload Completion and Abort

**Description:** `POST /videos/:id/upload/complete` finalizes the multipart, verifies the size, moves to `processing` and enqueues; `DELETE /videos/:id/upload` aborts a draft. (TD-03, TD-04, TD-08 + R1)

**Technical actions:**

- `src/videos/dto/complete-upload.dto.ts` — `parts: CompletedPartDto[]` (`@ArrayMinSize(1)`, `@ArrayMaxSize(10000)`, `@ValidateNested`), `CompletedPartDto { partNumber: int 1–10000; etag: string }`.
- `VideosService.completeUpload(userId, videoId, dto)`: load owned video (`VideoNotFoundException` if missing or not owned) → require `status=draft` (`VideoInvalidStatusException`) → `completeMultipartUpload` → `getObjectSize`; if size ≠ `size_bytes`: delete object, set `status=error`, `error_reason='SIZE_MISMATCH'`, throw `UploadSizeMismatchException` → update `status=processing`, `upload_id=null` → `producer.enqueue(id)`; if enqueue throws: set `status=error`, `error_reason='ENQUEUE_FAILED'`, re-throw.
- `VideosService.abortUpload(userId, videoId)`: owned + `draft` → `abortMultipartUpload` → delete row.

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- E2E: init (6 MiB file) → PUT both parts to the presigned URLs (test env `S3_PUBLIC_ENDPOINT=http://minio:9000`) → complete → `200` with `status=processing`; the producer is called with the video id (job shape/idempotency asserted in SI-03.5 against Redis — asserting the job in e2e would race with the running `video-worker`).
- E2E: complete with a wrong ETag → `422 UPLOAD_PARTS_INVALID`; second complete → `409 VIDEO_INVALID_STATUS`; another user's video → `404 VIDEO_NOT_FOUND`.
- E2E: declared size ≠ uploaded size → `422 UPLOAD_SIZE_MISMATCH` and DB `status=error`.
- E2E: `DELETE /videos/:id/upload` on a draft → `204`, row removed; on a `processing` video → `409`.
- Unit: enqueue failure sets `error`/`ENQUEUE_FAILED` and re-throws.

---

### SI-03.7 — Media Probe Service (ffprobe / ffmpeg)

**Description:** A `MediaModule` that wraps the FFmpeg CLI: metadata extraction and single-frame capture from a URL, without downloading the whole file. (TD-05 + R1, TD-11)

**Technical actions:**

- `src/media/media.service.ts` — `probe(url): Promise<ProbeResult>` (spawns `ffprobe -v error -print_format json -show_format -show_streams <url>`); `captureFrame(url, atSeconds): Promise<Buffer>` (spawns `ffmpeg -v error -ss <t> -i <url> -frames:v 1 -vf scale=640:-2 -q:v 3 -f image2 pipe:1`). Non-zero exit → `MediaProcessingError(stderr)`.
- `src/media/ffprobe.parser.ts` — pure `parseProbeOutput(json): { durationSeconds, metadata: VideoMetadata }`; throws `MediaProcessingError('NO_VIDEO_STREAM')` when no video stream; `frameRate` from `avg_frame_rate` (`"30000/1001"` → 29.97).
- `src/media/thumbnail-time.util.ts` — `thumbnailTimestamp(duration) = duration < 1 ? 0 : Math.min(duration * 0.1, 10)`.
- `src/test/video-fixture.ts` — generates a 3 s test MP4 with `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=25 -f lavfi -i sine=duration=3` into a temp file (test helper only).

**Dependencies:** SI-03.1, SI-03.3 (types)

**Acceptance criteria:**

- Unit: parser maps a captured ffprobe JSON to the `VideoMetadata` shape; missing video stream → error; fractional frame rate parsed; `thumbnailTimestamp` boundaries (0.5 → 0, 30 → 3, 600 → 10).
- Integration (real ffmpeg + MinIO): fixture uploaded to MinIO; `probe(internalPresignedUrl)` returns duration ≈ 3 s, 320×240, `h264`; `captureFrame` returns a buffer starting with the JPEG magic bytes `FF D8`.
- Integration: `probe` on a text file → `MediaProcessingError`.

---

### SI-03.8 — Video Worker (Processor + Entrypoint)

**Description:** The worker process consuming `video-processing`: probe, thumbnail, persist, and the final-failure path. (TD-01, TD-05, TD-08, TD-11)

**Technical actions:**

- `src/videos/video-processing.service.ts` — `process(videoId)`: load video (must be `processing`, otherwise log and return — idempotent) → internal presigned GET → `media.probe` → `media.captureFrame(thumbnailTimestamp)` → `storage.putObject(videoThumbnailKey)` → conditional update `WHERE id = :id AND status = 'processing'` setting `status=ready`, `duration_seconds`, `metadata`, `thumbnail_key`, `processed_at`. `markFailed(videoId, reason)`: conditional update to `error` with `error_reason` (truncated to 255).
- `src/worker/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extends `WorkerHost`; `process(job)` calls `VideoProcessingService.process(job.data.videoId)`; `@OnWorkerEvent('failed')` calls `markFailed` only when `job.attemptsMade >= job.opts.attempts` (catch-and-log allowed here per `nestjs-services.md` background rule).
- `src/worker/worker.module.ts` — `ConfigModule.forRoot` (same load + Joi), `TypeOrmModule.forRootAsync`, `QueueModule`, `BullModule.registerQueue`, `StorageModule`, `MediaModule`, `TypeOrmModule.forFeature([Video])`; providers `VideoProcessingService`, `VideoProcessor`.
- `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, `enableShutdownHooks()`.

**Dependencies:** SI-03.5, SI-03.6, SI-03.7

**Acceptance criteria:**

- Integration (real DB + MinIO + ffmpeg): a `processing` video whose original is the fixture becomes `ready` with `duration_seconds ≈ 3`, metadata populated and a thumbnail object present.
- Integration: a `processing` video whose original is not a video ends in `error` with a non-empty `error_reason` after `markFailed`; calling `process` on a `ready` video changes nothing.
- Integration (real Redis): a BullMQ `Worker` built from `WorkerModule` consumes an enqueued job and the row becomes `ready`.
- `docker compose logs video-worker` shows the worker started without HTTP listener.

---

### SI-03.9 — Video Read, Streaming and Download Endpoints

**Description:** Owner-only details by slug and 302 redirects to presigned URLs for stream, download and thumbnail. (TD-06, TD-07, TD-09)

**Technical actions:**

- `VideosService.getOwnedBySlug(userId, slug)`; `getStreamUrl`, `getDownloadUrl` (require `ready` → `VideoNotReadyException`; download file name = sanitized title + original extension), `getThumbnailUrl` (require `thumbnail_key`).
- `src/videos/dto/video-response.dto.ts` — response shape per API Contracts (no storage keys, no `upload_id`).
- Controller: `GET /videos/:slug`, `GET /videos/:slug/stream`, `GET /videos/:slug/download`, `GET /videos/:slug/thumbnail` using `@Redirect()`; all authenticated (no `@Public()`); controller marked `@SkipThrottle()` because the auth `ThrottlerGuard` is registered globally (`APP_GUARD`).

**Dependencies:** SI-03.4, SI-03.8

**Acceptance criteria:**

- E2E: `GET /videos/:slug` returns the contract shape for the owner; another user → `404 VIDEO_NOT_FOUND`; no token → `401`.
- E2E: on a `ready` video, `/stream` → `302`; following the `Location` with `Range: bytes=0-1023` → `206` and `Content-Range` header; `/download` `Location` response carries `Content-Disposition: attachment`; `/thumbnail` → `302` to a JPEG.
- E2E: `/stream` on a `draft`/`processing` video → `409 VIDEO_NOT_READY`.

---

### SI-03.10 — End-to-End Pipeline and Documentation

**Description:** One E2E test that crosses every component (API → MinIO → Redis → worker container → DB → streaming), plus CLAUDE.md/OpenAPI updates. (all TDs)

**Technical actions:**

- `test/videos.e2e-spec.ts` — "full pipeline" case: register/confirm/login → init → PUT parts → complete → poll `GET /videos/:slug` until `status=ready` (timeout 60 s, served by the running `video-worker` container) → stream with Range → 206.
- Update root `CLAUDE.md` (queue = BullMQ/Redis; videos module) and `nestjs-project/CLAUDE.md` (services `minio`, `redis`, `video-worker`, readiness probes, worker commands, videos endpoints).
- Regenerate `nestjs-project/openapi.json` with `npm run openapi:export`.

**Dependencies:** SI-03.9

**Acceptance criteria:**

- Full-pipeline E2E passes with the Compose stack up.
- `npx tsc --noEmit` exits 0, `npm run lint` passes, `npm test -- --runInBand` and `npm run test:e2e` pass.
- Every file/endpoint/command cited in both CLAUDE.md files exists.

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | Generated in the app (`randomUUID()`) before the insert so the storage key is known (TD-02) |
| channel_id | uuid | FK → channels.id, not null, ON DELETE CASCADE | Owner channel |
| title | varchar(100) | not null | From init DTO; editable in Phase 04 |
| slug | varchar(16) | unique, not null | 11-char base64url (TD-06) |
| status | enum `videos_status_enum` (`draft`,`processing`,`ready`,`error`) | not null, default `draft` | Processing state only (TD-08 R1) |
| original_file_name | varchar(255) | not null | Used for the download file name |
| content_type | varchar(100) | not null | Declared at init (allowlist) |
| size_bytes | bigint | not null | Declared size; checked against HeadObject at completion |
| storage_key | varchar(255) | not null | `videos/{id}/original` |
| upload_id | varchar(1024) | nullable | S3 multipart upload id while `draft`; `null` after completion |
| thumbnail_key | varchar(255) | nullable | `thumbnails/{id}/thumbnail.jpg` when `ready` |
| duration_seconds | numeric(10,3) | nullable | Set by worker (TD-11) |
| metadata | jsonb | nullable | `VideoMetadata` (TD-11) |
| error_reason | varchar(255) | nullable | Set when `status=error` |
| processed_at | timestamp | nullable | When the worker finished successfully |
| created_at | timestamp | not null, auto | |
| updated_at | timestamp | not null, auto | |

**Relations:** Video → Channel (many-to-one via `channel_id`); Channel → Video (one-to-many, inverse).
**Indexes:** `(slug)` unique; `(channel_id)`.
**TypeORM note:** `size_bytes` (bigint) is returned by `pg` as a string — use a column `transformer` to `number` (10 GiB fits in `Number.MAX_SAFE_INTEGER`). Same for `duration_seconds` (numeric).

`VideoMetadata` (jsonb):

```ts
interface VideoMetadata {
  width: number; height: number;
  videoCodec: string; audioCodec: string | null;
  bitRate: number | null; frameRate: number | null;
  formatName: string; sizeBytes: number;
}
```

**Status transitions:**

| From | To | Trigger | Actor |
|------|----|---------|-------|
| — | draft | `POST /videos/uploads` | API |
| draft | processing | `POST /videos/:id/upload/complete` (size ok, enqueued) | API |
| draft | error | completion with size mismatch | API |
| processing | error | enqueue failure (API) or final job failure (worker) | API / worker |
| processing | ready | job succeeded | worker |
| draft | (deleted) | `DELETE /videos/:id/upload` | API |

### API Contracts

All endpoints require `Authorization: Bearer <access_token>` (TD-09). Errors use `{ statusCode, error, message }`.

#### POST /videos/uploads (SI-03.4)

**Request body:**
- title: string, required — 1–100 chars
- fileName: string, required — 1–255 chars
- fileSize: integer, required — 1 … 10737418240
- contentType: string, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`

**Response 201:**
- id: string (uuid)
- slug: string
- status: `"draft"`
- upload: `{ partSize: number, partCount: number, expiresIn: number, parts: [{ partNumber: number, url: string }] }`

**Error responses:** 400 VALIDATION_ERROR; 401; 404 CHANNEL_NOT_FOUND.

**Client contract:** PUT each part body (bytes `[(n-1)·partSize, n·partSize)`) to `parts[n].url`, read the `ETag` response header, then call complete.

---

#### POST /videos/:id/upload/complete (SI-03.6)

**Request body:**
- parts: array (1–10000) of `{ partNumber: integer 1–10000, etag: string }`

**Response 200:** `VideoResponse` with `status: "processing"`.

**Error responses:** 400 VALIDATION_ERROR; 401; 404 VIDEO_NOT_FOUND; 409 VIDEO_INVALID_STATUS; 422 UPLOAD_PARTS_INVALID; 422 UPLOAD_SIZE_MISMATCH.

---

#### DELETE /videos/:id/upload (SI-03.6)

**Response 204:** no body.

**Error responses:** 401; 404 VIDEO_NOT_FOUND; 409 VIDEO_INVALID_STATUS.

---

#### GET /videos/:slug (SI-03.9)

**Response 200 (`VideoResponse`):**
- id: string (uuid); slug: string; title: string
- status: `draft | processing | ready | error`
- durationSeconds: number | null; metadata: `VideoMetadata` | null
- errorReason: string | null
- hasThumbnail: boolean
- createdAt: string (ISO); processedAt: string | null

**Error responses:** 401; 404 VIDEO_NOT_FOUND.

---

#### GET /videos/:slug/stream · /download · /thumbnail (SI-03.9)

**Response 302:** `Location` = presigned GET URL (public client, `PRESIGNED_URL_EXPIRATION_SECONDS`). `/download` adds `response-content-disposition=attachment; filename="<title>.<ext>"`. Storage answers `Range` requests with `206 Partial Content`.

**Error responses:** 401; 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY (stream/download when not `ready`); 404 THUMBNAIL_NOT_FOUND (thumbnail before processing).

### Events / Messages

#### Queue `video-processing` — job `video.process`

| Field | Value |
|-------|-------|
| Broker | Redis (`redis:6379`), BullMQ 5 |
| Producer | API — `VideoProcessingProducer.enqueue` after a successful completion (SI-03.6) |
| Consumer | `video-worker` container — `VideoProcessor` (SI-03.8) |
| Job id | `videoId` (idempotent: duplicate adds are ignored) |
| Payload | `{ "videoId": "<uuid>" }` — no other data; the worker reads the current row |
| Options | `attempts: 3`, `backoff: { type: "exponential", delay: 5000 }` (5 s, 10 s), `removeOnComplete: true`, `removeOnFail: false` |
| Success effect | `videos.status = ready` + duration/metadata/thumbnail; thumbnail object written |
| Failure effect | each failed attempt is retried; after the 3rd, `failed` handler sets `status = error`, `error_reason = <message>` |
| Idempotency | worker skips videos not in `processing`; final update is conditional on `status = 'processing'` |

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|---------------|-------|
| POST /videos/uploads | | ✓ | Video created in the caller's channel |
| POST /videos/:id/upload/complete | | ✓ | Owner only (others get 404) |
| DELETE /videos/:id/upload | | ✓ | Owner only; `draft` only |
| GET /videos/:slug | | ✓ | Owner only (TD-09) |
| GET /videos/:slug/stream | | ✓ | Owner only; `ready` only |
| GET /videos/:slug/download | | ✓ | Owner only; `ready` only |
| GET /videos/:slug/thumbnail | | ✓ | Owner only |

Presigned URLs are bearer capabilities valid for `PRESIGNED_URL_EXPIRATION_SECONDS` (default 3600 s).

### Error Catalog

Format inherited from Phase 02: `{ statusCode, error, message }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for user | Init when the authenticated user has no channel |
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown id/slug, or the video belongs to another channel |
| VIDEO_INVALID_STATUS | 409 | Video is not in a valid status for this operation | Complete/abort when status ≠ `draft` |
| VIDEO_NOT_READY | 409 | Video is not ready | Stream/download when status ≠ `ready` |
| THUMBNAIL_NOT_FOUND | 404 | Thumbnail not available | Thumbnail before processing finished |
| UPLOAD_PARTS_INVALID | 422 | Uploaded parts are invalid or incomplete | S3 `InvalidPart`, `InvalidPartOrder`, `NoSuchUpload`, `EntityTooSmall` on complete |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded file size does not match the declared size | HeadObject size ≠ declared `fileSize` |

Worker-only (persisted in `error_reason`, not HTTP): `NO_VIDEO_STREAM`, ffprobe/ffmpeg stderr, `ENQUEUE_FAILED`, `SIZE_MISMATCH`.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.3
├── SI-03.5
└── SI-03.7 (also SI-03.3 for types)

SI-03.2 + SI-03.3
└── SI-03.4

SI-03.4 + SI-03.5
└── SI-03.6

SI-03.5 + SI-03.6 + SI-03.7
└── SI-03.8

SI-03.4 + SI-03.8
└── SI-03.9
    └── SI-03.10
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.5 (parallel) → SI-03.7 → SI-03.4 → SI-03.6 → SI-03.8 → SI-03.9 → SI-03.10

## Deliverables

- [ ] MinIO (+ bucket bootstrap with CORS), Redis and `video-worker` start with `docker compose up -d` next to `nestjs-api`
- [ ] Upload up to 10 GiB via presigned S3 multipart — no video byte passes through the API
- [ ] Draft video pre-registered on upload initiation
- [ ] Completion verifies size, moves to `processing` and enqueues `video.process`
- [ ] Worker extracts duration + metadata (ffprobe) and generates a thumbnail (ffmpeg), then marks `ready`; final failure marks `error`
- [ ] Unique 11-char slug per video enforced by a unique index
- [ ] Streaming via 302 → presigned URL with Range/206; download with `Content-Disposition: attachment`
- [ ] `videos` table migration linked to `channels`
- [ ] Unit + integration (real MinIO/Redis/ffmpeg/Postgres) + E2E tests green
- [ ] `npx tsc --noEmit` exits 0; `npm run lint` passes
- [ ] Root and `nestjs-project` CLAUDE.md updated; `openapi.json` regenerated
- [ ] All tests pass (`docker compose exec nestjs-api npm test -- --runInBand`, `docker compose exec nestjs-api npm run test:e2e`)
