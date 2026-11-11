---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-11
scope_description: "Backend foundation for video upload and processing: object storage usage (MinIO/S3), processing queue technology, direct-to-storage upload of files up to 10GB, draft pre-registration, background FFmpeg worker (metadata + thumbnail), unique video URL, streaming and download, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the `videos` module (upload init/complete/abort, read, stream, download), the processing queue producer, the video worker (second entrypoint of the same codebase) and the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — Frontend deferred: the video upload/player UI is explicitly out of scope for this phase (challenge statement: "a interface de vídeo não faz parte do escopo desta fase"). Cross-layer TDs below (TD-03, TD-07) still define the HTTP handshake the future frontend will consume, so no frontend-only TD is needed now.

Inherited constraints (not reopened): NestJS 11 + TypeORM 0.3 + PostgreSQL 17 (`project-plan.md` Stack); object storage is S3-compatible — MinIO locally, S3 in production (`CLAUDE.md` Architecture, `software-arch.mermaid`); custom JWT guard with global `JwtAuthGuard` + `@Public()` and `DomainException` error contract (`phase-02-auth`/TD-02, TD-07); `class-validator` DTOs (`phase-02-auth`/TD-06); Joi env validation and Compose service names as hosts (`phase-01-configuracao-base`, `CLAUDE.md` Docker Networking).

---

## TD-01: Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the Message Queue as "TBD". The API must publish a processing job after each upload and a separate worker must consume it with retries. The queue must run as a real Compose service and be exercised by integration tests.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq` + `bullmq`)
- Redis-backed job queue. The API injects a `Queue` (`@InjectQueue`) and calls `add()`; the worker declares a `@Processor()` class extending `WorkerHost`. Retries are configured per job with `attempts` + `backoff` (fixed or exponential).
- **Pros:** Official NestJS integration documented in the "Queues" technique page; first-class job semantics (attempts, backoff, job id for idempotency, completed/failed events, stalled-job recovery); one small extra container (`redis`); same TypeScript codebase for producer and consumer.
- **Cons:** Redis must be persistent (AOF) to avoid losing jobs on restart; not a general-purpose message broker (no fan-out routing like AMQP exchanges); jobs are tied to the BullMQ format (both sides must be Node).

### Option B: RabbitMQ (`@nestjs/microservices` RMQ transport or `amqplib`)
- AMQP broker. The API publishes a message to a queue; the worker consumes with manual ack. Retries require dead-letter exchanges + TTL queues or a delayed-message plugin.
- **Pros:** Mature broker, language-agnostic messages, routing flexibility, management UI.
- **Cons:** Retry/backoff is not built in (DLX + TTL topology must be designed); job state (attempt count, failure reason) must be tracked manually; heavier container; the NestJS microservices transport is request/event oriented, not job oriented.

### Option C: pg-boss (queue on the existing PostgreSQL)
- Job queue stored in Postgres tables using `SKIP LOCKED`. No new broker container.
- **Pros:** Zero new infrastructure; jobs can be enqueued in the same DB transaction as the status change (no dual write).
- **Cons:** No official NestJS module; adds polling load to the primary DB; the architecture diagram models the queue as a dedicated container, and the challenge requires "fila ... real subindo no Compose" — reusing the DB weakens that boundary.

**Recommendation:** **Option A (BullMQ + Redis)** — the only option with official NestJS support and built-in retry/backoff/idempotency, which TD-08 (failure handling) depends on; the dual-write risk of Option C's advantage is handled by TD-08's ordering rule.

**Decision:** _[pending]_

---

## TD-02: Object Storage Usage (bucket, key layout, SDK, endpoints)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage choice (S3/MinIO) is given. What remains open is how it is used, and this is a cross-component contract: bucket name and env keys appear in the Joi schema, `compose.yaml`, the bucket bootstrap container, the API and the worker. A MinIO-specific problem also applies: SigV4 presigned URLs sign the `Host` header, so a URL signed for the internal host `minio:9000` fails with `SignatureDoesNotMatch` when used from the host machine/browser.

**Options:**

### Option A: Single private bucket, prefixed keys, `@aws-sdk/client-s3` with two endpoints
- One bucket (`S3_BUCKET=streamtube`), private (no anonymous policy). Keys: `videos/{videoId}/original` and `thumbnails/{videoId}/thumbnail.jpg`. The official AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) with `forcePathStyle: true`. Two clients: internal (`S3_ENDPOINT=http://minio:9000`) for server-side calls and public (`S3_PUBLIC_ENDPOINT=http://localhost:9000`) used only to sign URLs handed to clients.
- **Pros:** Same SDK and code for MinIO and S3 (swap only env vars); keys derived from the immutable video id — no collisions and no user-controlled names in keys; one bucket keeps IAM/CORS/lifecycle simple; solves the host-signature mismatch explicitly.
- **Cons:** Two S3 clients to configure; private bucket means every read goes through a presigned URL (see TD-07).

### Option B: Two buckets (`videos`, `thumbnails`), thumbnails public
- Separate buckets; thumbnails bucket with anonymous read policy so the frontend can link directly.
- **Pros:** Thumbnail URLs are stable and cacheable without signing.
- **Cons:** Public bucket exposes thumbnails of draft/unpublished videos (visibility arrives in Phase 04); two buckets to bootstrap and configure; still needs the dual-endpoint fix for video uploads.

### Option C: MinIO JS SDK (`minio` package)
- Use MinIO's own client instead of the AWS SDK.
- **Pros:** Simple API for presigned GET/PUT.
- **Cons:** Production target is S3 — the AWS SDK is the canonical client there; presigned multipart part URLs are not a first-class helper in the MinIO client.

**Recommendation:** **Option A** — one private bucket with id-derived keys and the AWS SDK v3 keeps local MinIO and production S3 identical, and the explicit public endpoint avoids the known SigV4 host mismatch in Docker.

**Decision:** _[pending]_

---

## TD-03: Upload Strategy for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Passing a 10GB body through the API ties up an API process and memory/disk for the whole transfer (auto-fail criterion of the challenge). S3 caps a single PUT (including presigned PUT/POST) at 5GB, so 10GB requires multipart upload. Backend defines the handshake; the future frontend implements the client side of it.

**Options:**

### Option A: Direct-to-storage S3 multipart upload with presigned part URLs
- `POST /videos/uploads` → API creates the draft video, calls `CreateMultipartUpload` and returns `videoId`, `uploadId`, `partSize`, `partCount` and one presigned `UploadPart` URL per part. The client PUTs each part directly to storage (in parallel, retrying individual parts) and collects the `ETag`s. `POST /videos/:id/upload/complete` with `{ parts: [{ partNumber, etag }] }` → API calls `CompleteMultipartUpload`. `DELETE /videos/:id/upload` → `AbortMultipartUpload`.
- **Pros:** No video byte ever crosses the API; works up to S3's object limit; per-part retry; parallel parts; identical on MinIO and S3.
- **Cons:** Three-step handshake to implement on the client; requires CORS on the bucket exposing the `ETag` header for browsers; abandoned uploads leave orphan parts until aborted.

### Option B: tus resumable protocol through the API (`@tus/server` + S3 store)
- The API hosts a tus endpoint; the tus server streams chunks into S3 multipart.
- **Pros:** Standard resumable protocol with ready-made clients (Uppy, tus-js-client); resume after browser restart.
- **Cons:** All 10GB still flow through the API container (bandwidth/CPU on the API, the thing the capability says must not be impacted); extra server component inside Nest/Express; harder horizontal scaling (upload state locking).

### Option C: Streaming multipart/form-data through the API (busboy → S3 `Upload`)
- The API streams the request body directly to S3 without buffering to disk.
- **Pros:** Single request from the client; simplest client.
- **Cons:** Holds one API connection for the entire upload; no resume; a failed transfer restarts from zero; explicitly the "wrong path" described in the challenge.

**Recommendation:** **Option A** — it is the only option where the API is fully out of the data path, which is literally what "sem impacto na performance" requires; resumability is achieved at part granularity.

**Decision:** _[pending]_

---

## TD-04: Upload Limits and Validation Policy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The API never sees the bytes (TD-03), so limits must be enforced at init (declared metadata) and re-checked at completion (real object). Part size must respect S3 rules: 5 MiB–5 GiB per part (last part may be smaller), max 10,000 parts.

**Options:**

### Option A: Declared-then-verified limits, fixed part size
- At init, the DTO requires `title`, `fileName`, `fileSize` (1 byte … 10 GiB = 10,737,418,240 bytes) and `contentType` in an allowlist (`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`). Part size fixed at 64 MiB → at most 160 parts for 10 GiB. After `CompleteMultipartUpload`, the API runs `HeadObject` and rejects (deletes object, marks `error`) if the real size differs from the declared one. The worker's `ffprobe` is the authoritative content check (no video stream → `error`). Presigned part URLs expire in 1 hour (configurable).
- **Pros:** Enforceable without seeing the bytes; small, predictable number of URLs; content type is only a hint, real validation happens on the actual file.
- **Cons:** A malicious client can upload garbage of the declared size — caught only at processing time (by design).

### Option B: Variable part size computed per file
- Choose the part size so that the count stays near a target (e.g., 100 parts).
- **Pros:** Fewer requests for small files.
- **Cons:** More rules to test; no benefit at 10 GiB scale (64 MiB already yields ≤160 parts).

**Recommendation:** **Option A** — fixed 64 MiB parts stay far from S3's 10,000-part ceiling and the HeadObject + ffprobe double check covers the cases the API cannot see.

**Decision:** _[pending]_

---

## TD-05: Video Worker Runtime and Media Tooling

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The architecture defines a "Video Worker (FFmpeg)" container separate from the API. We must decide where its code lives, how it invokes FFmpeg, and how it reads a source file of up to 10GB.

**Options:**

### Option A: Same NestJS codebase, second entrypoint, `ffprobe`/`ffmpeg` via `child_process.spawn`, reading the source over a presigned GET URL
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server) registering the BullMQ `@Processor`. Compose service `video-worker` uses the same image with `ffmpeg` installed and runs the worker entrypoint. `ffprobe -print_format json -show_format -show_streams <presignedUrl>` extracts duration/metadata; `ffmpeg -ss <t> -i <presignedUrl> -frames:v 1 thumbnail.jpg` grabs one frame (t = 10% of duration, capped, 0 for very short videos). FFmpeg reads via HTTP range requests, so the 10GB file is never fully downloaded.
- **Pros:** Reuses entities, repositories, config, DomainException and tests infra; zero new npm dependency for media (no wrapper); no 10GB temp-disk copy; worker scales independently of the API.
- **Cons:** Worker image must include FFmpeg (bigger image); parsing ffprobe JSON and process exit codes is our code to test.

### Option B: Same as A but with `fluent-ffmpeg`
- Use the wrapper library to build commands.
- **Pros:** Fluent API, built-in `ffprobe()` helper.
- **Cons:** The package is deprecated on npm and no longer maintained — a new dependency we would adopt already end-of-life.

### Option C: Separate worker project (own `package.json`)
- A standalone Node project under the repo.
- **Pros:** Smaller worker image, hard isolation.
- **Cons:** Duplicates entities/config/DB access or forces a shared package (monorepo tooling decision not justified by this phase).

**Recommendation:** **Option A** — one codebase, a dedicated container, direct FFmpeg CLI calls and HTTP-range reads give a real worker without duplicating the domain or adopting a deprecated wrapper.

**Decision:** _[pending]_

---

## TD-06: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a public identifier for its URL (e.g., `/watch/{slug}`) that never collides and does not leak internal ids or counts. It will be consumed by the frontend in Phases 04–05.

**Options:**

### Option A: 11-char URL-safe random slug (base64url of `crypto.randomBytes(8)`), unique index, retry on collision
- `slug` column `varchar(16)` unique. Generated with Node's `crypto` (64 bits of entropy, YouTube-style length). On unique-violation (Postgres `23505`) regenerate up to 3 times.
- **Pros:** Short, shareable, non-enumerable; uniqueness guaranteed by the DB, not by probability; no dependency.
- **Cons:** Second identifier alongside the UUID primary key.

### Option B: Use the UUID primary key in the URL
- **Pros:** Nothing to generate.
- **Cons:** 36-char URLs; exposes the internal key as the public contract.

### Option C: Title-based slug + suffix (`meu-video-a1b2`)
- **Pros:** SEO-friendly.
- **Cons:** Titles are editable in Phase 04 → URL changes or drifts from the title; more collision handling.

**Recommendation:** **Option A** — a DB-enforced unique random slug gives conflict-free, stable, short URLs independent of title edits.

**Decision:** _[pending]_

---

## TD-07: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The architecture states "Frontend → Object Storage: Streams". Streaming without full download requires HTTP Range (206 Partial Content). Download requires `Content-Disposition: attachment`.

**Options:**

### Option A: API authorizes, then redirects (302) to a short-lived presigned GET URL
- `GET /videos/:slug/stream` → 302 to a presigned GET (inline). `GET /videos/:slug/download` → 302 to a presigned GET with `ResponseContentDisposition=attachment; filename="..."`. `GET /videos/:slug/thumbnail` → 302 likewise. Storage serves Range/206 natively.
- **Pros:** Bytes flow storage → client (matches the diagram); Range/seek handled by S3/MinIO; API keeps the authorization decision; `<video src>` follows redirects transparently.
- **Cons:** URL is a bearer token until it expires (mitigated by short expiry, e.g., 1 hour); redirect adds one round trip.

### Option B: API proxies the bytes with Range support
- API parses `Range`, calls `GetObject` with `Range`, pipes the stream with 206 headers.
- **Pros:** Storage never exposed; full header control.
- **Cons:** All playback bandwidth crosses the API — the same performance problem TD-03 removed for upload.

### Option C: Adaptive streaming (HLS/DASH transcoding)
- Worker transcodes into segments + manifest.
- **Pros:** Adaptive bitrate.
- **Cons:** Heavy CPU/storage, out of the phase capabilities (metadata + thumbnail only); not required to "reproduzir sem download completo".

**Recommendation:** **Option A** — redirect to presigned URLs keeps media traffic off the API while giving native Range/206 playback and attachment downloads.

**Decision:** _[pending]_

---

## TD-08: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video row is created when the upload starts and moves through processing. We must define states, transitions, what triggers processing, and what happens on failure — including the dual write between DB status and queue publish.

**Options:**

### Option A: `draft → processing → ready | error`, processing triggered by the client's complete call, BullMQ retries, idempotent job
- `draft`: row created at upload init (multipart open). `processing`: set by the API after a successful `CompleteMultipartUpload` + HeadObject check, then the job `video.process` is enqueued with `jobId = videoId` (idempotent: re-enqueue is a no-op). If enqueue fails, the API marks the video `error` (`errorReason='ENQUEUE_FAILED'`) so state never claims processing without a job. Worker: `attempts: 3`, exponential backoff; on success sets `ready` + duration/metadata/thumbnail key; on final failure (`failed` event with attempts exhausted) sets `error` + `errorReason`. Worker transitions are conditional (`UPDATE ... WHERE status='processing'`) so duplicate deliveries cannot regress a `ready` video. Abort (`DELETE /videos/:id/upload`) is allowed only in `draft` and removes the row.
- **Pros:** Matches the required cycle exactly; no external trigger to configure; failure is visible in the DB; retries absorb transient storage errors.
- **Cons:** Relies on the client calling complete (an upload finished but never completed stays `draft`; cleanup of stale drafts is a future task).

### Option B: Storage event notifications (MinIO bucket notification → queue)
- MinIO publishes `s3:ObjectCreated:CompleteMultipartUpload` to Redis/AMQP; a consumer flips status and starts processing.
- **Pros:** Works even if the client never calls complete.
- **Cons:** MinIO- and S3-specific configuration differ (S3 uses SNS/SQS/EventBridge); notification payload format becomes a contract; harder to test deterministically; the API still has to call `CompleteMultipartUpload` for presigned multipart, so the client call exists anyway.

### Option C: Transactional outbox table + relay
- Status change and an outbox row in one transaction; a relay publishes to the queue.
- **Pros:** Exactly-once intent between DB and queue.
- **Cons:** Extra table and relay process for a single event type; disproportionate for this phase.

**Recommendation:** **Option A** — the complete call already exists in the multipart flow, so it is the natural trigger; ordering (status then enqueue, fail-to-error) plus idempotent job id and conditional worker updates cover the dual-write risk without an outbox.

**Decision:** _[pending]_

---

## TD-09: Access Policy for Video Reads in Phase 03

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Visibility (public/unlisted) and the draft→publication flow belong to Phase 04; anonymous watching is a Phase 05 capability. Phase 03 must still deliver working stream/download without opening unpublished videos to everyone.

**Options:**

### Option A: Owner-only in Phase 03
- All `/videos` endpoints require JWT; read/stream/download/thumbnail only for the channel owner; stream/download only when `status=ready`. Phase 04/05 relax this with visibility rules.
- **Pros:** No content leaks before a publication model exists; nothing to undo later.
- **Cons:** Anonymous playback is not demonstrable until Phase 05.

### Option B: Public for `ready` videos
- `@Public()` on stream/download/thumbnail when `status=ready`.
- **Pros:** Demonstrates anonymous streaming now.
- **Cons:** Every processed video becomes public before Phase 04 defines publishing/visibility — would have to be tightened later (behavior regression risk).

**Recommendation:** **Option A** — keeps Phase 03 within its capabilities and leaves visibility/anonymous access to the phases that own them.

**Decision:** _[pending]_

---

## TD-10: Compose Topology and Environment Contract for New Services

**Scope:** Repo-wide

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Serviço de processamento em segundo plano (filas)

**Context:** Three new services must start with `docker compose up` alongside the API, and the env keys are shared by the Joi schema, `compose.yaml`, the API and the worker (cross-component contract).

**Options:**

### Option A: `minio` + one-shot `minio-init` (mc) + `redis` (AOF) + `video-worker` built from the same Dockerfile with ffmpeg
- `minio` (ports 9000 API / 9001 console, healthcheck); `minio-init` (`minio/mc`) creates the bucket and applies CORS (exposing `ETag`) then exits; `redis` with `--appendonly yes` and healthcheck; `video-worker` uses `Dockerfile.dev` (now installing `ffmpeg`), same volume, command runs the worker entrypoint. API and worker `depends_on` healthy `db`, `redis`, `minio` and completed `minio-init`. Env keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `REDIS_HOST`, `REDIS_PORT`, `UPLOAD_MAX_FILE_SIZE`, `UPLOAD_PART_SIZE`, `PRESIGNED_URL_EXPIRATION_SECONDS`, all validated by Joi.
- **Pros:** One `docker compose up -d` brings everything up; same image → integration tests that need ffmpeg run in the API container too; hosts are service names (`minio`, `redis`), per `CLAUDE.md`.
- **Cons:** The API image also carries ffmpeg (larger dev image).

### Option B: Separate worker Dockerfile; bucket created by the app at boot
- **Pros:** Smaller API image.
- **Cons:** Integration tests for the worker must run in a different container; app-side bucket creation mixes infra bootstrap into runtime code.

**Recommendation:** **Option A** — a single image and an init container keep setup to one command and let every test level run against the real services.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Processing Queue Technology | A (BullMQ + Redis) | _[pending]_ |
| TD-02 | Backend | Object Storage Usage | A (single private bucket, id keys, AWS SDK v3, dual endpoint) | _[pending]_ |
| TD-03 | Cross-layer | Upload Strategy for 10GB | A (presigned S3 multipart, direct to storage) | _[pending]_ |
| TD-04 | Backend | Upload Limits and Validation | A (declared + HeadObject + ffprobe, 64 MiB parts) | _[pending]_ |
| TD-05 | Backend | Worker Runtime and Media Tooling | A (same codebase, 2nd entrypoint, ffmpeg CLI over presigned URL) | _[pending]_ |
| TD-06 | Cross-layer | Unique Video URL Identifier | A (11-char random slug, unique index) | _[pending]_ |
| TD-07 | Cross-layer | Streaming and Download Delivery | A (302 to presigned GET) | _[pending]_ |
| TD-08 | Backend | Status Lifecycle and Failure Handling | A (draft→processing→ready/error, complete-triggered, retries) | _[pending]_ |
| TD-09 | Backend | Access Policy for Reads in Phase 03 | A (owner-only) | _[pending]_ |
| TD-10 | Repo-wide | Compose Topology and Env Contract | A (minio + minio-init + redis + video-worker, same image) | _[pending]_ |
