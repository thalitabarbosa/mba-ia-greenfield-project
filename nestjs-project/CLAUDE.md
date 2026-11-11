# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose exec minio mc ready local` — expect ready; `docker compose ps -a minio-init` must show `Exited (0)` (bucket `streamtube` created)

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (image includes `ffmpeg`/`ffprobe`, needed by tests)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, web UI `8025`
- `redis` — Redis 7 (AOF on), port `6379` — BullMQ broker
- `minio` — S3-compatible storage (`pgsty/silo` image, a maintained MinIO fork: official MinIO images were removed from Docker Hub), API `9000`, console `9001` (user `streamtube` / `streamtube-secret`)
- `minio-init` — one-shot container (same image, bundled `mc`) that creates the `streamtube` bucket, then exits
- `video-worker` — same image/volume as `nestjs-api`; runs `npm run start:worker` (`src/worker.ts`, no HTTP server). It waits until `node_modules` exists, so run `npm install` in `nestjs-api` first. Logs: `docker compose logs -f video-worker`. Restart it after changing worker code: `docker compose restart video-worker`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run migration:run                    # Apply migrations (incl. CreateVideos)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## Videos Module (Phase 03)

| Path | Responsibility |
|------|----------------|
| `src/videos/` | `VideosController` (`/videos`), `VideosService` (upload init/complete/abort, owner-only reads), `VideoProcessingService` (worker-side transitions), `VideoProcessingProducer`, `Video` entity, DTOs |
| `src/storage/` | `StorageService` — the only S3/MinIO client (multipart, presigned URLs, head/put/delete); internal vs public client |
| `src/queue/` | `QueueModule` (BullMQ root + `video-processing` queue), job name/options/payload |
| `src/media/` | `MediaService` — spawns `ffprobe`/`ffmpeg` (no npm wrapper); pure parsers |
| `src/worker/` + `src/worker.ts` | `WorkerModule` and `VideoProcessor` (`@Processor('video-processing')`) for the `video-worker` container |
| `src/config/{storage,queue,upload}.config.ts` | `S3_*`, `PRESIGNED_URL_EXPIRATION_SECONDS`, `REDIS_*`, `UPLOAD_MAX_FILE_SIZE`, `UPLOAD_PART_SIZE` (validated in `env.validation.ts`) |

Endpoints (all require a Bearer token; videos opt out of the auth throttler with `@SkipThrottle()`):

| Method | Path | Result |
|--------|------|--------|
| POST | `/videos/uploads` | 201 — draft + presigned part URLs |
| POST | `/videos/:id/upload/complete` | 200 — `processing`, job enqueued |
| DELETE | `/videos/:id/upload` | 204 — draft aborted |
| GET | `/videos/:slug` | 200 — details (status, duration, metadata) |
| GET | `/videos/:slug/stream` · `/download` · `/thumbnail` | 302 — presigned storage URL |

Testing notes:

- Storage, queue and worker tests hit the real Compose services (`*.integration-spec.ts`); fixtures are generated with `ffmpeg` (`src/test/video-fixture.ts`).
- `src/test/jest-setup-env.ts` (in both Jest configs) forces `S3_PUBLIC_ENDPOINT=http://minio:9000` because `localhost:9000` is unreachable from inside `nestjs-api`.
- Queue integration tests use a unique BullMQ prefix (`src/test/queue-test.utils.ts`) so the running `video-worker` does not steal their jobs; the full-pipeline e2e (`test/videos.e2e-spec.ts`) relies on the running `video-worker`.
- `.env` must contain `S3_ACCESS_KEY` and `S3_SECRET_KEY` (Joi-required) — copy the new keys from `.env.example`.

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
