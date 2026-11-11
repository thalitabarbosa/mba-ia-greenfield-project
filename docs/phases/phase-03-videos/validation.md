---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-11T09:25:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T09:20:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-11T09:20:00-03:00"
issues: []
advisories: [ADV-1]
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._ Every capability in `## Capability Coverage` maps to at least one decided TD.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._ New endpoints keep the global `JwtAuthGuard` (phase-02-auth/TD-02), DTO validation (TD-06) and the `DomainException` error contract (TD-07); new config follows `registerAs` + Joi (phase-01).

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ (`next-frontend/` not in scope.)

### Advisories

- **ADV-1** — `library-refs.md` was sourced from official docs via web because context7 was not available in the planning session. Non-blocking: re-confirm with context7 against the installed versions at the start of SI-03.1 (first install step).

## Resolved Issues

| Issue | Pass | Resolution |
|-------|------|------------|
| IC-1 — signing client for worker URLs | 1 | `phase-03-videos/TD-02` R1: internal client signs URLs consumed inside Docker; public client signs client-facing URLs |
| AM-1 — thumbnail timestamp undefined | 1 | `phase-03-videos/TD-05` R1: `t = min(duration × 0.1, 10s)`, 0 when < 1s; JPEG width 640 |
| MD-1 — metadata shape not decided | 1 | New `phase-03-videos/TD-11` (decided A): `duration_seconds` column + curated `metadata` jsonb |
| DG-1 — libraries not pinned / BullMQ v6 | 1 | `library-refs.md` created; `bullmq@^5.76.0` pinned below v6, `@nestjs/bullmq@^11.0.4`, AWS SDK v3 |
| UQ-1 — `draft` vs Phase 04 publication | 1 | `phase-03-videos/TD-08` R1: `status` is processing state only |
| UQ-2 — presigned URLs inside test container | 1 | `phase-03-videos/TD-02` R1: tests use `S3_PUBLIC_ENDPOINT=http://minio:9000` |
