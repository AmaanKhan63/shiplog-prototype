/**
 * Inject a failure on demand (resilience demos). Drives the REAL pipeline: a real
 * ingest queue job, processed by the REAL worker (`npm run worker`), dead-lettered
 * to the REAL dead_letter collection, replayed through the REAL
 * `POST /dlq/:id/replay` endpoint. No simulated shortcuts.
 *
 *   npm run inject recovery    # NEW record fails -> DLQ; replay lands it 1st time -> events +1
 *   npm run inject duplicate   # record whose key already exists; replay -> same row, events +0
 *   npm run inject transient   # 5xx-style error -> retries with backoff -> DLQ (re-fails on replay)
 *   npm run inject logical     # bad-payload error -> straight to DLQ, no retry
 *
 * `recovery` and `duplicate` use a SELF-HEALING fault: the record fails every
 * attempt until it dead-letters, then recovers — so a verbatim replay succeeds.
 * That's the honest "transient outage that clears" story, against the real worker:
 *   - recovery  proves RECOVERY     — parked in the DLQ it is NOT in events;
 *                                     replay ingests it for the first time (+1).
 *   - duplicate proves IDEMPOTENCY  — its key already matches a seeded event;
 *                                     replay lands as the SAME row, count unchanged.
 *
 * `transient` / `logical` keep the original M2 behavior: the fault is baked into
 * the payload, so such an item RE-FAILS on replay (by design).
 *
 * The injected records are clearly-labelled synthetic commits (author
 * `shiplog-demo`, host `example.invalid`) — deliberate fault injection, never
 * dressed up as real data, and never your real synced commits.
 */
import { randomBytes } from 'node:crypto'
import type { Types } from 'mongoose'
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { redisConnectionOptions } from '../src/queue/connection.js'
import { createIngestQueue, INGEST_QUEUE } from '../src/queue/queues.js'
import { githubFixtures } from '../src/fixtures/github.js'
import { Tenant, Connection, SyncRun, Event, DeadLetter } from '../src/models/index.js'
import { ingestEvent } from '../src/events/ingest.js'
import { normalizeGithubRecord } from '../src/normalize/github.js'
import { ensureDemoContext } from './_demo.js'
import type { FailMode } from '../src/queue/types.js'
import type { NangoRecord } from '../src/nango/types.js'

const VALID = ['recovery', 'duplicate', 'idempotency', 'transient', 'logical'] as const
type Mode = (typeof VALID)[number]

const mode = (process.argv[2] || '').toLowerCase() as Mode
if (!VALID.includes(mode)) {
  console.error(`Usage: npm run inject <${VALID.join('|')}>`)
  process.exit(2)
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms))

/** A clearly-labelled synthetic commit with a fresh, unique sha. */
function buildDemoCommit(label: string): NangoRecord {
  const sha = `demo-${label}-${randomBytes(5).toString('hex')}`
  const now = new Date().toISOString()
  return {
    id: `nango-${sha}`,
    _nango_metadata: { model: 'GithubCommit', cursor: `cursor-${sha}`, deleted_at: null, last_modified_at: now },
    sha,
    html_url: `https://example.invalid/shiplog-demo/commit/${sha}`,
    author: { login: 'shiplog-demo' },
    commit: { message: `Demo fault-injection (${label}) — synthetic record, not a real commit`, author: { name: 'shiplog-demo', date: now } },
  } as unknown as NangoRecord
}

/** Poll for the dead_letter doc the REAL worker writes after exhausting retries. */
async function waitForDeadLetter(tenantId: Types.ObjectId, faultId: string, timeoutMs = 45000) {
  const start = Date.now()
  for (;;) {
    const dl = await DeadLetter.findOne({ tenantId, 'payload.demoFault.id': faultId }).sort({ failedAt: -1 }).lean()
    if (dl) return dl
    if (Date.now() - start > timeoutMs) return null
    await delay(1000)
  }
}

async function main() {
  await connectDB(config.mongoUri)
  const queue = createIngestQueue(redisConnectionOptions())
  queue.on('error', (err) => console.error(`[queue] error: ${err?.message}`))

  // ---- Original M2 behavior: payload-baked poison (re-fails on replay) -------
  // Standalone on the auto-created demo tenant; needs no prior setup.
  if (mode === 'transient' || mode === 'logical') {
    const { ctx } = await ensureDemoContext('reconcile')
    const record = { ...githubFixtures.find((r) => r._nango_metadata.model === 'GithubCommit')! }
    const job = await queue.add(INGEST_QUEUE, { ...ctx, record, poison: mode as FailMode })
    console.log(`Injected a ${mode} failure as job ${job.id}.`)
    console.log(
      mode === 'transient'
        ? 'Expect: 5 attempts with exponential backoff (~1s, 2s, 4s, 8s) in the worker log, then one dead_letter doc (attemptsMade=5).'
        : 'Expect: 1 attempt, no retry, immediate dead_letter doc (attemptsMade=1).'
    )
    console.log('(payload-baked poison: a replay of this item re-fails, by design — use `recovery` to show recovery.)')
    await queue.close()
    await disconnectDB()
    process.exit(0)
  }

  // ---- recovery / duplicate: self-healing fault, recovers on replay ----------
  // Run on the Acme tenant, so the failure→replay story and the isolation demo
  // share one tenant. Requires `npm run setup-tenants <nangoConnectionId> github`.
  const tenant = await Tenant.findOne({ apiKey: 'acme-api-key' })
  if (!tenant) {
    console.error('Tenant "acme-api-key" not found — run `npm run setup-tenants <nangoConnectionId> github` first.')
    await queue.close()
    await disconnectDB()
    process.exit(2)
  }
  const tenantId = tenant._id
  const apiKey = tenant.apiKey
  const connection = await Connection.findOne({ tenantId })
  const syncRun = await SyncRun.create({ tenantId, connectionId: connection?._id, trigger: 'reconcile', status: 'running' })
  const ctx = {
    tenantId: tenantId.toString(),
    connectionId: connection?._id?.toString(),
    syncRunId: syncRun._id.toString(),
  }
  const countEvents = () => Event.countDocuments({ tenantId })
  const isDuplicate = mode === 'duplicate' || mode === 'idempotency'
  const baseline = await countEvents()
  console.log(`tenant "${tenant.name}" (apiKey=${apiKey})   events at start = ${baseline}`)

  const record = buildDemoCommit(isDuplicate ? 'duplicate' : 'recovery')
  const sha = String((record as Record<string, unknown>).sha)

  if (isDuplicate) {
    // Seed the baseline event so the record's idempotency key ALREADY exists.
    const { status } = await ingestEvent(normalizeGithubRecord(record), { tenantId })
    console.log(`Seeded the duplicate's target event (${status}): events ${baseline} -> ${await countEvents()}`)
  }

  await queue.add(INGEST_QUEUE, { ...ctx, record, demoFault: { id: sha } })
  console.log(`\nInjected ${mode} fault for synthetic commit ${sha}.`)
  console.log('Watch the worker: ~5 attempts with backoff (1s, 2s, 4s, 8s), then a dead_letter doc.')
  console.log('Polling for the dead-letter (the worker must be running)...')

  const dl = await waitForDeadLetter(tenantId, sha)
  if (!dl) {
    console.log('\n⏱  No dead_letter doc after 45s. Is the worker running (`npm run worker`)?')
    console.log('   The job is queued; start the worker and it will retry -> dead-letter, then replay it.')
    await queue.close()
    await disconnectDB()
    process.exit(0)
  }

  const afterDlq = await countEvents()
  console.log(`\nDead-lettered:  dlqId=${dl._id}   attemptsMade=${dl.attemptsMade}`)
  console.log(`events now = ${afterDlq}   (parked in the DLQ — the failed attempts wrote nothing)`)
  console.log('\nReplay it (the outage is now "resolved", so it lands) — through the real endpoint, no curl:')
  console.log('  npm run replay              # replays this dead-letter (the most recent for Acme)')
  console.log(`  # or target it explicitly:  npm run replay ${dl._id}`)
  console.log(
    isDuplicate
      ? `Expected after replay: events stays ${afterDlq}  (idempotent no-op — SAME row, same key, no duplicate).`
      : `Expected after replay: events ${afterDlq} -> ${afterDlq + 1}  (+1 — recovered and ingested for the first time).`
  )
  console.log(`Verify (mongosh):  db.events.countDocuments({ tenantId: ObjectId("${tenantId}") })`)

  await queue.close()
  await disconnectDB()
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
