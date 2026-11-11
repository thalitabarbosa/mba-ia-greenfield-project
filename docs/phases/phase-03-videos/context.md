---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-11T08:40:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-11T09:05:00-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-05-12T12:23:19-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-05-12T12:21:12-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-05-12T12:23:19-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, categorias, visibilidade (público/unlisted) e fluxo rascunho → publicação (Fase 04); player, página de visualização e acesso anônimo (Fase 05); interface de vídeo no `next-frontend/`.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo não faz parte do escopo desta fase (enunciado do desafio). Os TDs Cross-layer (TD-03, TD-06, TD-07) fixam o contrato HTTP que o frontend consumirá depois.

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta (vídeos pertencem a um canal; endpoints usam o `JwtAuthGuard` global).

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Processing Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.0.x, bullmq@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Object Storage Usage | decided | A (single private bucket, id keys, AWS SDK v3, dual endpoint) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Strategy for 10GB | decided | A (presigned S3 multipart) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Upload Limits and Validation | decided | A (declared + HeadObject + ffprobe, 64 MiB parts) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Worker Runtime and Media Tooling | decided | A (same codebase, 2nd entrypoint, ffmpeg CLI) | ffmpeg (Debian package in image) |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Cross-layer | Unique Video URL Identifier | decided | A (11-char random slug, unique index) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming and Download Delivery | decided | A (302 to presigned GET) | @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Status Lifecycle and Failure Handling | decided | A (draft→processing→ready/error) | bullmq@^5.x |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Access Policy for Reads in Phase 03 | decided | A (owner-only) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Repo-wide | Compose Topology and Env Contract | decided | A (minio + minio-init + redis + video-worker) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-10 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-09 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07, phase-03-videos/TD-09 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — the only option with official NestJS support and built-in retry/backoff/idempotency, which TD-08 (failure handling) depends on; the dual-write risk of Option C's advantage is handled by TD-08's ordering rule.

**Libraries:** `@nestjs/bullmq@^11.0.x`, `bullmq@^5.x`

### phase-03-videos/TD-02

**Recommendation:** Option A — one private bucket with id-derived keys and the AWS SDK v3 keeps local MinIO and production S3 identical, and the explicit public endpoint avoids the known SigV4 host mismatch in Docker.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Option A — it is the only option where the API is fully out of the data path, which is literally what "sem impacto na performance" requires; resumability is achieved at part granularity.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-04

**Recommendation:** Option A — fixed 64 MiB parts stay far from S3's 10,000-part ceiling and the HeadObject + ffprobe double check covers the cases the API cannot see.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Option A — one codebase, a dedicated container, direct FFmpeg CLI calls and HTTP-range reads give a real worker without duplicating the domain or adopting a deprecated wrapper.

**Libraries:** `ffmpeg`/`ffprobe` binaries from the Debian package installed in `Dockerfile.dev`

### phase-03-videos/TD-06

**Recommendation:** Option A — a DB-enforced unique random slug gives conflict-free, stable, short URLs independent of title edits.

**Libraries:** — (Node `crypto`)

### phase-03-videos/TD-07

**Recommendation:** Option A — redirect to presigned URLs keeps media traffic off the API while giving native Range/206 playback and attachment downloads.

**Libraries:** `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-08

**Recommendation:** Option A — the complete call already exists in the multipart flow, so it is the natural trigger; ordering (status then enqueue, fail-to-error) plus idempotent job id and conditional worker updates cover the dual-write risk without an outbox.

**Libraries:** `bullmq@^5.x`

### phase-03-videos/TD-09

**Recommendation:** Option A — keeps Phase 03 within its capabilities and leaves visibility/anonymous access to the phases that own them.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Option A — a single image and an init container keep setup to one command and let every test level run against the real services.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only — global `JwtAuthGuard` registered as `APP_GUARD`, `@Public()` opt-out, `@CurrentUser()` decorator.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — documented NestJS approach; global `ValidationPipe`.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — `{ statusCode, error, message }` with domain codes; new errors extend `DomainException`.

**Libraries:** —

### phase-01-configuracao-base/TD-02 / TD-03

**Recommendation:** Joi `validationSchema` + namespaced `registerAs()` config factories injected via `ConfigType<typeof xxxConfig>`.

**Libraries:** `@nestjs/config@^4.x`, `joi`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by the Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true`, `synchronize: false`; schema changes only via versioned migrations in `src/database/migrations/`. _(from phase 01)_
- All endpoints are protected by the global `JwtAuthGuard`; `@Public()` opts out; the authenticated user comes from `@CurrentUser()`. _(from phase 02)_
- Domain errors extend `DomainException(errorCode, httpStatus, message)` in `src/common/exceptions/domain.exception.ts` and are rendered as `{ statusCode, error, message }`. _(from phase 02)_
- Each user owns exactly one channel (`channels.user_id` unique); channel lookup belongs to `ChannelsModule`/`ChannelsService`. _(from phase 02)_
- Tests: `*.spec.ts` (unit), `*.integration-spec.ts` (real DB/services via `createTestDataSource`), `*.e2e-spec.ts` (supertest); run inside the `nestjs-api` container with `--runInBand`. _(from phase 02)_
- Compose service names are used as hosts — never `localhost` inside containers. _(from CLAUDE.md)_

## Inherited Deferred Capabilities

| Capability | From | Status |
|------------|------|--------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | phase-02-auth | delivered by phase-02-auth-frontend — not relevant to this phase |

## Non-UI / Deferred Capabilities

_No capability of this phase is deferred._ (The video UI is not a Phase 03 capability in `project-plan.md`; it is excluded by the challenge statement.)

## Open Questions

- OQ-1: The Phase 03 status `draft` (pre-registration during upload) and the Phase 04 capability "Fluxo de rascunho → publicação" use the same word. Does the `status` column also carry publication state?
- OQ-2: Integration/E2E tests run inside the `nestjs-api` container, where the public endpoint (`localhost:9000`) is not reachable. How do tests use presigned URLs?

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces an entity + migration, an infrastructure adapter (S3 storage), a queue producer, a queue processor (worker) and HTTP endpoints. Storage, queue and worker are exercised against the real MinIO/Redis/FFmpeg from Compose (integration + E2E); unit tests cover pure logic (slug generation, part planning, ffprobe output parsing, status transitions). Specific layer coverage by SI is recorded in `progress.md`.
