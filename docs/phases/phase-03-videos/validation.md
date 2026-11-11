---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 6
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-11T09:10:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T09:05:00-03:00"
issues: [IC-1, AM-1, MD-1, DG-1, UQ-1, UQ-2]
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `phase-03-videos/TD-02` states that presigned URLs are signed by the *public* client (`S3_PUBLIC_ENDPOINT=http://localhost:9000`), while `phase-03-videos/TD-05` has the worker read the source through a presigned GET URL. Inside the `video-worker` container `localhost:9000` is the container itself, so ffprobe/ffmpeg would fail. The decision must say which client signs which URL.

### Ambiguities

- **AM-1** — `phase-03-videos/TD-05` picks the thumbnail frame at "10% of duration, capped, 0 for very short videos" without the cap value or the "very short" threshold. The worker unit tests cannot assert behavior without numbers.

### Missing Decisions

- **MD-1** — Capability "Processamento automático do vídeo após upload (extração de duração e metadados)" is covered by TD-05/TD-08, but no TD fixes *which* metadata is persisted and in what shape (columns vs JSON). This is a cross-component contract (worker writes it, API returns it, migration defines it).

### Dependency Gaps

- **DG-1** — No `library-refs.md` exists for the new libraries (`@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`). BullMQ published a new major (v6.0.0, 2026-07-30) with breaking changes (e.g., `Worker#resume()` became async); compatibility with `@nestjs/bullmq@11` must be pinned before planning.

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **UQ-1** — context.md OQ-1: does `status = draft` also mean "not published"? Risk of colliding with Phase 04's draft → publication flow.
- **UQ-2** — context.md OQ-2: tests run inside `nestjs-api`; presigned URLs signed for `localhost:9000` are unreachable there.

### UI Coverage Gaps

_None._ (`next-frontend/` not in scope.)

## Resolved Issues

_No issues resolved yet._
