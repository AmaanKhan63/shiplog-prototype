# Demo rehearsal checklist

The live **failure → replay → no-duplicate → isolation** walkthrough. Each beat below
can be driven two ways:

- **Scripts** — deterministic, ~90 seconds, and they *print* the proof. The most
  reliable way to rehearse: `npm run verify`, `npm run replay-demo`, `npm run reconcile-demo`.
- **Dashboard** — the visual version for a live audience: `npm run seed`, then three
  terminals, then click through at <http://localhost:5173>.

**Watch the right surface.** The **DLQ panel**, **Events count**, and the **tenant
switch** are dashboard-visible. **Exponential backoff** and the **reconcile cursor** are
**worker-log** observations — the scripts print them; no panel shows them. Don't promise
the audience a screen that won't move.

---

## Pre-flight

- [ ] MongoDB on `:27017`, Redis on `:6379` (no Docker needed)
- [ ] `npm install` done; `.env` present (set `NANGO_WEBHOOK_SECRET` for the webhook path)
- [ ] `npm run seed` → two isolated tenants: **Acme** (5 events, 1 DLQ item), **Globex** (3 events)
- [ ] Terminal 1: `npm start` (API, `:3000`)
- [ ] Terminal 2: `npm run worker` (jobs actually run; **keep this visible** — backoff prints here)
- [ ] Terminal 3: `cd dashboard && npm run dev` (dashboard, `:5173`)
- [ ] **Reset between takes:** replay/backfill mutate data — re-run `npm run seed` to restore the clean state.

> **90-second fallback:** if any wiring misbehaves live, run the three scripts in order.
> They reset their own state and print every proof below deterministically.

---

## The walkthrough (7 beats)

### 1 — Steady state · *"Nango fetched; my layer normalized and stored."*
- [ ] **Dashboard:** Acme selected → **Events = 5**, the **Sync Runs** table shows runs
      with added/updated/deleted/failed, duration, trigger.
- [ ] **Script (cursor + webhook proof):** `npm run reconcile-demo` → Path 1 signs a Nango
      webhook → **2 issues land as events**.
- Point made: Nango delivers the records; this layer normalizes them into one tenant-scoped
  event spine and logs each run.

### 2 — Idempotency · *"Re-running never duplicates."*
- [ ] **Script:** `npm run verify` → `Run 1: added=6` then `Run 2: added=0 updated=0` (a no-op).
- [ ] **Dashboard:** click **Reconcile** on the connection twice → the second Sync Run shows
      `added=0` (unique idempotency key makes it a no-op).
- Point made: the unique idempotency key turns a re-sync (or a replay) into a guaranteed no-op.

### 3 — Inject a failure · *"Only transient errors retry — with backoff and jitter."*
- [ ] **Script:** `npm run replay-demo` → Step 2 simulates a downstream outage and re-sends
      the same record.
- [ ] **Surface = WORKER LOG** (Terminal 2 / the script's output), not a panel. You'll see:
      ```
      [backoff] attempt 1 failed (transient) -> retry in 618ms
      [backoff] attempt 2 failed (transient) -> retry in 1081ms
      [backoff] attempt 3 failed (transient) -> retry in 2141ms
      [backoff] attempt 4 failed (transient) -> retry in 4637ms
      ```
- Point made: exponential backoff + jitter, capped at 5 attempts; a *logical* error would
  skip retries and dead-letter immediately.

### 4 — Land in the DLQ · *"An alert, not an archive."*
- [ ] **Script:** the same run prints `[DLQ] … -> dead_letter <id> after 5 attempt(s)`.
- [ ] **Dashboard:** the **Dead-Letter Queue** panel shows the item — its error message and
      attempt count — and the count badge ticks up.
- Point made: full failure context is persisted (payload, error, attempts, tenant). In
  production you alert on the DLQ *rate* (that alert is named under "what I'd add" in the README).

### 5 — Fix & replay · *"Re-enqueue the original payload, verbatim."*
- [ ] **Dashboard:** click **Replay** on the DLQ row → the row is marked **replayed** (it
      stays listed) and the re-flowed event appears in **Events**.
- [ ] **Script:** `replay-demo` Step 4 → `POST /dlq/<id>/replay -> unchanged`.
- Point made: replay puts the *same* payload back on the queue, so the worker recomputes the
  *same* idempotency key.

### 6 — Prove no duplicates · *"At-least-once delivery, idempotent consumer — effectively once."*
- [ ] **Script:** `replay-demo` prints the clincher:
      ```
      _id            = …d90e   (SAME row)
      idempotencyKey = 1fbd4ca5…3966   (SAME key)
      events = 1   (UNCHANGED — no duplicate)
      ```
- [ ] **Dashboard:** the **Events** count did not double — exactly one row for the record,
      even though it was processed twice (failed once, replayed once).
- Point made: same key → same row. The failure was an external toggle, so replay is truly verbatim.

### 7 — Prove isolation · *"Tenant B can't see Tenant A — and a test enforces it."*
- [ ] **Dashboard:** flip the **tenant switcher** Acme → Globex. Every panel changes
      (Events 5 → 3, the DLQ item disappears); nothing leaks across.
- [ ] **Proof:** `npx vitest run test/isolation.test.ts` (3 pass). It asserts Tenant B's API
      key and repository wrapper read **none** of Tenant A's events — and it **fails if the
      `tenantId` filter is removed from `withTenant`** (the app-level RLS guard).
- Point made: isolation is enforced in code and pinned by a negative test, not just asserted.

---

## Reliability bonus — the cursor invariant (if asked about dropped webhooks)

- [ ] `npm run reconcile-demo` → Path 2 takes the records API **down**: the reconcile job
      retries with backoff, **fails**, and the cursor is **HELD at ∅**. Path 3 recovers: the
      cursor **ADVANCES to `c-102`** with no duplicate events.
- Point made: the cursor advances **only after** a page is durably landed — a dropped webhook
  is re-delivered by the poll, and a crash never skips a record. *"Advances on success, holds on failure."*

---

## One-line framing to land

> "Nango gets the data to my door reliably — OAuth, fetch, base sync, webhooks. My layer
> makes it correct, unified, replayable, isolated per tenant, and observable."
