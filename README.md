# shiplog-sync

A one-directional ingestion + resilience layer for [Shiplog](https://useshiplog.com),
built **on top of Nango** in MERN. Nango owns the GitHub connection and base sync;
this layer turns Nango's per-source records into a unified, deduped, tenant-scoped
**event spine** with the enterprise guarantees: idempotent writes, dedup, retries +
backoff, a dead-letter queue, replay/backfill, hard multi-tenant isolation, and
observability.

> Direction is **source → store only** (GitHub into Shiplog). No write-back, no
> conflict resolution.

This repo is built in milestones. **Milestones 0–1 are complete** (scaffold +
idempotent event spine). See [Roadmap](#roadmap).

---

## Quick start

Prereqs: Node ≥ 20 and a local MongoDB running on `mongodb://localhost:27017`
(no Docker required).

```bash
npm install
cp .env.example .env        # MONGODB_URI etc. (a local .env is already present)
npm run verify              # the Milestone 1 demo (below)
npm test                    # full test suite
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

---

## Architecture (so far)

```
Nango-shaped records ─▶ normalize (per source) ─▶ NormalizedEventSchema (Zod)
                                                          │
                                          idempotencyKey + contentHash
                                                          │
                                                idempotent upsert
                                                          ▼
                                        events  (unified, deduped spine)
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

**MERN as a deliberate 1:1 analog of Shiplog's stack.** Mongo + `tenantId` + repo
guard ↔ Postgres/Drizzle + RLS; Express routes ↔ Next.js route handlers; BullMQ +
Redis (from M2) ↔ Inngest durable jobs.

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
  fixtures/github.js     # static Nango-shaped GitHub records
  app.js                 # Express app factory
  server.js              # entrypoint
scripts/seed-and-verify.js   # `npm run verify`
test/                    # vitest suite (runs against a local test DB)
```

## Testing

Tests run against `mongodb://localhost:27017/shiplog-sync-test` (dropped per run;
the demo DB is never touched). `npm test` runs the full suite.

## Roadmap

- **M0 ✅** scaffold, models + indexes, tenant API-key middleware
- **M1 ✅** Zod event schema, unique idempotency index, idempotent upsert +
  content-hash dedup, fixtures, verify demo
- **M2** BullMQ pipeline: retry/backoff + jitter, error classifier, DLQ
- **M3** replay / backfill (failure → replay → no-duplicate)
- **M4** real Nango GitHub integration (webhooks + signature verify)
- **M5** reconciliation poller (cursor advances on success only)
- **M6** React dashboard + observability
- **M7** README polish + negative isolation test + demo rehearsal
