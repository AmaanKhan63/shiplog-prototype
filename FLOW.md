# Architecture & data flow

A one-directional ingestion and resilience layer for Shiplog, built **on top of Nango**.
Nango owns the GitHub connection and the base sync; this layer turns Nango's per-source
records into a unified, deduped, tenant-scoped **event spine** with the enterprise
guarantees on top: idempotent writes, dedup, retries with backoff, a dead-letter queue,
replay and backfill, hard multi-tenant isolation, and observability.

Data flows **one way** — GitHub *into* the store, never back out. That's deliberate: with
no write-back there's no conflict resolution and no two-way merge, which removes a large
amount of scope and leaves the problems that actually matter here — correctness, dedup,
resilience, and isolation.

**In one line:** two delivery paths (a real-time webhook and a reconciliation poller)
converge on a single idempotent ingest queue; a worker normalizes and dedupes each record
into the events spine; anything that fails every retry dead-letters and can be replayed
without ever creating a duplicate.

The numbered sections below match the numbered nodes in the architecture diagram.

---

## Setup (what exists before any data moves)

Two records sit in Mongo before the flow runs:

- A **tenant** — a customer, identified by an API key.
- A **connection** — a pointer to one real Nango connection (the GitHub one) plus the
  list of models to pull (default `["Commit"]`).

The sync **cursor** is kept separately, in its own `sync_state` collection — one row per
*tenant × connection × model*. It's not stored on the connection because the two have
different lifecycles: a connection is stable identity and configuration, while the cursor
is mutable progress that moves on every page. Keeping it separate is also what lets it
stay single-writer.

---

## 1–2 · GitHub → Nango

**GitHub** is the source of truth — commits, issues, pull requests.

**Nango** runs the actual sync against GitHub and caches the records on its side. This is
the part the layer deliberately does **not** rebuild: OAuth, the connection, the base
sync, and webhook delivery are problems Nango already solves reliably and across
providers. The value of this layer is everything that comes *after* Nango.

---

## 3 · Two delivery paths

Records reach the layer two independent ways, and both converge on the same ingest queue.
That redundancy is the entire resilience story for *delivery* — if one path misses
something, the other catches it.

**3a · Webhook (push, real-time).** When data changes, Nango sends a webhook to
`POST /webhooks/nango`. Importantly, that webhook is a **notification, not the data** — it
only says "N records changed for connection X, model Y." So the endpoint does three cheap
things and nothing more: verify the HMAC signature, respond `202` immediately, and enqueue
a sync job. It never fetches or processes inline, which keeps it fast and makes a
duplicated webhook harmless. The actual fetch happens one step later, in the **nango-sync
worker**, which calls `listRecords({ model, modifiedAfter })`, lands the raw records, and
enqueues one ingest job per record.

**3b · Reconciliation poller (poll, safety net).** Webhooks get dropped — the receiver may
be redeploying, the tunnel hiccups, Nango has a blip. So a repeatable background sweep
independently polls Nango on a durable cursor and re-delivers anything a missed webhook
left behind. The reconcile worker loads the cursor from `sync_state`, calls
`listRecords({ model, cursor })`, lands the page, enqueues ingest jobs, and **then**
advances the cursor — checkpoint-after-write, one page at a time.

The cursor invariant is the key property here: the cursor advances **only after** a page's
records are durably landed. If a fetch or a landing throws, the cursor holds where the
last good page left it and the job retries from there — never re-pulling all history,
never skipping a record. *Advances on success, holds on failure.* A reconcile job also
uses a deterministic job id per `(connection, model)`, so a manual trigger and a scheduled
tick collapse onto a single in-flight job rather than racing each other for the cursor.

A failed reconcile job is **not** dead-lettered — it has no DLQ, and doesn't need one. Its
retries back off (up to 5 attempts); if they're exhausted the job is dropped and the next
sweep simply re-runs it from the same held cursor. Reconcile is itself the safety net, so a
failure just waits for the next cycle; only the ingest path dead-letters, because a bad
payload can't be fixed by retrying while an unreachable Nango is fixed by trying again later.

> The two paths guard different failures. Reconcile is the **delivery** safety net — it
> makes sure every record arrives. The retry/dead-letter logic below is the **processing**
> safety net — it makes sure every arrived record is handled correctly.

---

## 4–5 · Ingest queue → ingest worker

**The ingest queue** is one BullMQ queue, in a process separate from the API, that *both*
delivery paths feed. Funnelling both paths through one queue means the resilience —
retries, backoff, dead-lettering — only had to be built once.

**The ingest worker** processes each record: **normalize** the Nango-shaped record into
the unified event shape, **validate** it with Zod, then perform an **idempotent upsert**
into the events spine.

Two distinct mechanisms operate here, and they're easy to conflate:

- **Dedup** is the **idempotency key** — `sha256(tenantId | source | externalId |
  version)`, backed by a unique index. Re-ingesting the same source version is a
  guaranteed no-op, even under concurrent workers. This is what makes retries and replays
  safe.
- **Isolation** is the **`tenantId` filter** applied on reads. Different concern, separate
  mechanism — one prevents duplicates, the other prevents cross-tenant leakage.

The model is **append-per-version**, not upsert-latest: each distinct source version is
its own row. That matters because replaying a *stale* version can then never overwrite
current state — it simply lands (or no-ops) as history. An upsert-latest model would let a
failed-then-replayed old version silently revert current state.

**Failure handling.** When the worker fails, an error classifier decides what happens:

- **Transient** errors (5xx, 429, network) are retried — up to 5 attempts, with
  exponential backoff plus jitter, honoring `Retry-After`. Jitter prevents synchronized
  retry storms.
- **Logical** errors (Zod validation failure, a bad or unmappable payload) are **not**
  retried. The job is marked unrecoverable and sent straight to the dead-letter queue —
  there's no point retrying a payload that will never get better.

---

## 6–7–8 · Events spine → tenant API → dashboard

**The events spine** is the payoff: one unified, deduped, tenant-scoped collection where
every row carries `tenantId`. Alongside it, `raw_records` holds the immutable raw landing —
the source for replay and backfill — while `events` is the normalized, queryable spine.

**The tenant API** serves `GET /events` (and the other tenant-scoped endpoints) through a
`withTenant(tenantId)` wrapper that injects the tenant filter into every query it issues.
This is **application-level row-level security** — the analog of Postgres RLS, used because
Mongo has none at the engine level, so the wrapper *is* the backstop. A negative isolation
test pins it: it proves one tenant cannot read another's rows, and fails if the `tenantId`
filter is ever removed from the wrapper.

**The dashboard** (React + React Query) makes the whole pipeline visible and operable from
one page: a tenant switcher, sync control (reconcile and backfill), sync-run history, the
dead-letter queue with a replay button, and the events count. Switching tenants re-scopes
every panel by API key — the live demonstration that nothing leaks across tenants.

---

## Failure → dead-letter → replay (the closure)

A record that fails every retry is written to the `dead_letter` collection with full
context — the payload, the error, the attempt count, and the tenant. It's an **alert, not
an archive**: once the underlying cause is fixed, `POST /dlq/:id/replay` re-enqueues the
**original payload verbatim**. The worker recomputes the **same idempotency key**, so the
write is a no-op against the unique index — same row, no duplicate.

This is the headline guarantee: *at-least-once delivery plus an idempotent consumer equals
effectively once.* Backfill is the bulk version of the same idea —
`POST /connections/:id/backfill` reprocesses every raw record for a connection, and because
ingestion is idempotent, re-running never duplicates.

---

## Guarantees at a glance

| Concern | How it's handled |
|---|---|
| **Dedup / idempotency** | `sha256(tenantId \| source \| externalId \| version)` + unique index; append-per-version |
| **Delivery resilience** | webhook *and* reconciliation poller; durable cursor that advances only after a page lands |
| **Processing resilience** | classified retries (transient → backoff+jitter; logical → straight to DLQ), then replay/backfill |
| **Tenant isolation** | `tenantId` on every row + `withTenant` wrapper (app-level RLS), pinned by a negative test |
| **Observability** | `sync_runs` history + structured logs; the DLQ rate is the signal you'd alert on |

**The frame:** Nango gets the data to the door reliably — OAuth, fetch, base sync,
webhooks. This layer makes it correct, unified, replayable, isolated per tenant, and
observable. One-directional on purpose, so the effort goes entirely into the guarantees
that matter.
