---
libs:
  "@nestjs/bullmq":
    version: "^11.0.4"
    source: "https://docs.nestjs.com/techniques/queues"
    fetched_at: "2026-11-11T09:20:00-03:00"
  bullmq:
    version: "^5.76.0"
    source: "https://docs.bullmq.io (guide: retrying failing jobs; changelog)"
    fetched_at: "2026-11-11T09:20:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    source: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html"
    fetched_at: "2026-11-11T09:20:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    source: "https://www.npmjs.com/package/@aws-sdk/s3-request-presigner (README)"
    fetched_at: "2026-11-11T09:20:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T09:20:00-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase. **Provenance note:** this file was produced in a session without the context7 MCP server available; sources are the official documentation pages listed in the frontmatter, read via web. Before `implement` installs the packages, re-run `/plan-resolve 03` in Claude Code with context7 enabled (or `npx ctx7`) to confirm the APIs against the exact versions written to `package-lock.json`, and flag any discrepancy here.

## @nestjs/bullmq + bullmq

**Maps to:** `phase-03-videos/TD-01`, `phase-03-videos/TD-08`.

**Version pin rationale:** BullMQ 6.0.0 (2026-07-30) is a new major with breaking changes (e.g., `Worker#resume()` now async). `@nestjs/bullmq@11.0.x` was built against BullMQ 5. Pin `bullmq@^5.76.0` (latest 5.x line observed) until `@nestjs/bullmq` declares v6 support.

Install: `npm install --save @nestjs/bullmq bullmq@^5`.

Root registration (async, using the project's config namespace):

```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.redisHost, port: cfg.redisPort },
  }),
}),
BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
```

Producer:

```typescript
constructor(@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue) {}
await this.queue.add('video.process', { videoId }, {
  jobId: videoId,              // idempotent: same id is not enqueued twice
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: false,
});
```

Consumer (worker):

```typescript
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoProcessJobData>): Promise<void> { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) { /* final failure → status error */ }
  }
}
```

Key facts used by the plan:
- `attempts` = total attempts (default 1); without a backoff, retries are immediate. Exponential delay = `2^(attemptsMade-1) × delay`.
- Throw `Error` instances from `process()` so BullMQ records the failure reason.
- Repeat jobs are no longer passed to `Queue.add()` (job schedulers) — not used in this phase.

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Maps to:** `phase-03-videos/TD-02`, `TD-03`, `TD-07`.

Install: `npm install --save @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`.

Client for MinIO (path-style is mandatory for `http://minio:9000/<bucket>`):

```typescript
new S3Client({
  endpoint: cfg.endpoint,          // internal: http://minio:9000 | public: http://localhost:9000
  region: cfg.region,              // e.g. us-east-1
  forcePathStyle: true,
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

Multipart commands: `CreateMultipartUploadCommand` → `UploadPartCommand` (presigned, one per part) → `CompleteMultipartUploadCommand({ MultipartUpload: { Parts: [{ PartNumber, ETag }] } })`; `AbortMultipartUploadCommand` to cancel. `HeadObjectCommand` returns `ContentLength` for the size check.

Presigning:

```typescript
const url = await getSignedUrl(publicClient,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });

const download = await getSignedUrl(publicClient,
  new GetObjectCommand({ Bucket, Key,
    ResponseContentDisposition: `attachment; filename="${safeName}"` }),
  { expiresIn: 3600 });
```

- `expiresIn` defaults to 900 s; SigV4 maximum is 7 days.
- SigV4 signs the `Host` header → a URL signed for `minio:9000` fails from the browser and vice versa (reason for the dual client, TD-02 R1).

S3 multipart limits (AWS user guide): parts 5 MiB–5 GiB (last part may be smaller), part numbers 1–10,000; single PUT capped at 5 GB → multipart is mandatory for 10 GB.

## ffmpeg / ffprobe (system binaries, no npm wrapper)

**Maps to:** `phase-03-videos/TD-05`, `TD-11`. `fluent-ffmpeg` is deprecated on npm, so the worker calls the binaries through `child_process.spawn`.

```
ffprobe -v error -print_format json -show_format -show_streams <url>
ffmpeg -v error -ss <t> -i <url> -frames:v 1 -vf scale=640:-2 -q:v 3 -f image2 pipe:1
```

Both accept HTTP(S) URLs and use range requests when seeking, so the worker never downloads the whole source.
