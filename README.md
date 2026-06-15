# shiplog-sync

A one-directional ingestion + resilience layer for [Shiplog](https://useshiplog.com),
built **on top of Nango** in MERN. Nango owns the GitHub connection and base sync;
this layer turns Nango's per-source records into a unified, deduped, tenant-scoped
**event spine** with the enterprise guarantees: idempotent writes, dedup, retries +
backoff, a dead-letter queue, replay/backfill, hard multi-tenant isolation, and
observability.

> Direction is **source → store only** (GitHub into Shiplog). No write-back, no
> conflict resolution.

This repo is built in milestones. **Milestones 0–2 are complete** (scaffold +
idempotent event spine + BullMQ retry/backoff + DLQ). See [Roadmap](#roadmap).

---

## Quick start

Prereqs: Node ≥ 20, a local MongoDB on `mongodb://localhost:27017`, and (for
Milestone 2) a Redis on `redis://localhost:6379` — or any `REDIS_URL`, including an
Upstash `rediss://` URL. No Docker required.

```bash
npm install
cp .env.example .env        # MONGODB_URI, REDIS_URL (a local .env is already present)
npm run verify              # the Milestone 1 demo (below)
npm test                    # full test suite (queue integration tests skip if Redis is down)
```

### The Milestone 1 demo — idempotency no-op

```bash
npm run verify
```

Ingests the static Nango-shaped GitHub fixtures **twice** and prints the run counts:

```
Run 1 (first ingest):   added=6  updated=0  deleted=0  failed=0  unchanged=0
Run 2 (re-ingest):      added=0  updated=0  deleted=0  failed=0  unchanged=6

✓ Idempotency no-op verified: re-ingesting the same data added 0 and updated 0.
```

The second run is a no-op: the unique idempotency key makes re-running a sync (or,
later, replaying a DLQ item) safe. The script resets the demo tenant's `events` and
`sync_runs` first, so `Run 1 → added:6` is reproducible on every invocation.

### The Milestone 2 demo — failure → retry/backoff → DLQ

Ingestion now runs through a **BullMQ** `ingest` queue with a **separate worker
process**. Two terminals:

```bash
# terminal 1 — the worker (separate process from the API)
npm run worker

# terminal 2 — drive it
npm run enqueue            # the 6 fixtures flow through the queue into events
npm run inject transient   # 5xx-style error → retries with backoff → DLQ
npm run inject logical     # bad-payload error → straight to DLQ, no retry
npm run dlq                # inspect the dead_letter records
```

The worker log shows the retry path for a transient failure (exponential backoff
**with jitter**), then the dead-letter after attempts are exhausted:

```
[backoff] attempt 1 failed (transient) -> retry in 1020ms
[backoff] attempt 2 failed (transient) -> retry in 2125ms
[backoff] attempt 3 failed (transient) -> retry in 4520ms
[backoff] attempt 4 failed (transient) -> retry in 8774ms
[DLQ]  job 10 poison:transient -> dead_letter <id> after 5 attempt(s) [transient: injected transient failure]
```

A `logical` failure skips retries entirely and is dead-lettered after 1 attempt.
Retries are safe because the processor calls the same idempotent `ingestEvent` from
Milestone 1 — re-processing can't duplicate.

---

## Architecture (so far)

```
Nango-shaped records ─▶ ingest queue (BullMQ) ─▶ worker (separate process)
                                                          │
                                          normalize ─▶ Zod ─▶ idempotent upsert
                                                          │
                                  success ──────────────┐ │ ┌──── transient: retry
                                                        ▼ ▼ ▼      (exp backoff + jitter)
                                        events (deduped spine)   logical: no retry
                                                            │
                                              terminal failure ▼
                                                   dead_letter (full context)
```

### Data model (MongoDB collections, spec §D)

`tenants` · `connections` · `sync_state` · `raw_records` · `events` · `sync_runs` ·
`dead_letter`. Indexes: **unique** `{idempotencyKey}` on `events`;
`{tenantId, externalId}` and `{tenantId, occurredAt}` on `events`; `{connectionId}`
on `sync_state`.

### Key design decisions

**Idempotency = append-per-version, not upsert-latest.**
`idempotencyKey = sha256(tenantId | source | externalId | version)`, with a unique
index. Each distinct source *version* is its own row, so:

- Re-ingesting the same version is a guaranteed no-op (unique-index backstop,
  even under concurrent workers).
- Replaying a *stale* version can never overwrite current state — it just lands (or
  no-ops) as history. This is what makes the upcoming **failure → replay →
  no-duplicate** demo (Milestone 3, the headline deliverable) correct rather than a
  silent state regression. An upsert-latest model would revert current state when a
  failed-then-replayed old version arrives.

**Content-hash dedup distinguishes a real update from a no-op.**
`contentHash` is computed over the *semantic* fields only (it excludes the `version`
token). A new version whose content is identical (e.g. a spurious `updatedAt` bump)
is suppressed as `unchanged`; only genuinely changed content counts as `updated` —
so dashboard counts reflect real change (à la Fivetran's `_fivetran_id`).

**Tenant isolation is application-enforced.** Every document carries `tenantId`;
`tenantId` is part of the idempotency key; and a `withTenant(tenantId)` repository
wrapper injects the tenant filter into every query — the app-level analog of
Postgres row-level security (Mongo has none at the engine level). The full wrapper +
a negative isolation test land in Milestone 7.

**Durable jobs with classified retries (Milestone 2).** Ingestion runs through a
BullMQ `ingest` queue processed by a **separate worker process**. An error
classifier decides retry policy (AWS guidance — only retry transient errors):

- **transient** (5xx / 429 / network) → retried up to 5 attempts with **exponential
  backoff + jitter**, honoring `Retry-After`. Jitter prevents synchronized retry
  storms.
- **logical** (Zod validation / bad payload / unmappable) → wrapped in BullMQ's
  `UnrecoverableError` and sent **straight to the DLQ, no retry** — you don't
  blindly retry a payload that will never get better.

On terminal failure the job is persisted to the `dead_letter` collection with full
context (payload, error stack, `attemptsMade`, timestamps, `tenantId`,
`connectionId`, `syncRunId`) and parked on a `dlq` queue for Milestone 3 replay.
Retries/replays are safe because the processor reuses the idempotent `ingestEvent`.

Secrets are never placed in job payloads (BullMQ stores `data` in cleartext) — jobs
carry only IDs and the public record.

**MERN as a deliberate 1:1 analog of Shiplog's stack.** Mongo + `tenantId` + repo
guard ↔ Postgres/Drizzle + RLS; Express routes ↔ Next.js route handlers; BullMQ +
Redis ↔ Inngest durable jobs (BullMQ retries whole jobs; Inngest checkpoints steps —
a distinction worth naming).

---

## Layout

```
src/
  config/env.js          # env config (dotenv)
  db/connect.js          # mongoose connect/disconnect
  models/                # 7 collections from spec §D, with indexes
  middleware/tenantAuth.js   # API key -> tenantId
  repository/withTenant.js   # tenant-scoped query wrapper (app-level RLS)
  normalize/github.js    # Nango GitHub record -> typed event
  events/
    schema.js            # NormalizedEventSchema (Zod)
    hash.js              # idempotencyKey + contentHash
    ingest.js            # idempotent upsert + content-hash dedup
  queue/
    connection.js        # ioredis (Upstash-compatible)
    queues.js            # ingest + dlq queues, default job options
    errors.js            # TransientError/LogicalError + classifyError
    backoff.js           # exponential backoff + jitter (pure)
    ingestProcessor.js   # normalize -> idempotent ingest; classify failures
    deadLetter.js        # terminal-failure detection + dead_letter persistence
    ingestWorker.js      # Worker factory: backoffStrategy + failed -> DLQ
  fixtures/github.js     # static Nango-shaped GitHub records
  app.js                 # Express app factory
  server.js              # API entrypoint
  worker.js              # ingest worker entrypoint (separate process)
scripts/
  seed-and-verify.js     # `npm run verify`  (M1 idempotency demo)
  enqueue-fixtures.js    # `npm run enqueue`
  inject-failure.js      # `npm run inject <transient|logical>`
  show-dlq.js            # `npm run dlq`
test/                    # vitest suite (runs against a local test DB)
```

## Testing

Two tiers:

- **`npm test`** — unit + Mongo-integration tests against
  `mongodb://localhost:27017/shiplog-sync-test` (dropped per run; the demo DB is
  never touched). Deterministic and Redis-free, so it runs anywhere. The queue's
  logic — error classification, backoff, the processor, terminal-failure/DLQ
  detection — is fully covered here.
- **`npm run test:integration`** — the live BullMQ retry→DLQ end-to-end test.
  Requires a reachable `REDIS_URL` (it self-skips if none is found). Kept separate
  because it depends on external infrastructure; on a rare worker-teardown exit
  (a Windows + Node + vitest-forks quirk, not a product bug), re-run it.

## Roadmap

- **M0 ✅** scaffold, models + indexes, tenant API-key middleware
- **M1 ✅** Zod event schema, unique idempotency index, idempotent upsert +
  content-hash dedup, fixtures, verify demo
- **M2 ✅** BullMQ pipeline: retry/backoff + jitter, error classifier, DLQ
  persistence, separate worker process, failure injection
- **M3** replay / backfill (failure → replay → no-duplicate)
- **M4** real Nango GitHub integration (webhooks + signature verify)
- **M5** reconciliation poller (cursor advances on success only)
- **M6** React dashboard + observability
- **M7** README polish + negative isolation test + demo rehearsal
