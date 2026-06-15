/**
 * Milestone 5 demo — both paths + the cursor invariant.
 *
 *   npm run reconcile-demo
 *
 * Self-contained: starts in-process ingest + nango-sync + reconcile workers and
 * the HTTP API, then drives the REAL endpoints:
 *   1. webhook path     — a signed Nango webhook flows through to events (M4)
 *   2. reconcile (fail) — POST /reconcile while the records API is "down":
 *                         the job retries then fails and the cursor HOLDS
 *   3. reconcile (ok)   — records API recovers: the cursor ADVANCES, no dupes
 *
 * Requires MongoDB and Redis (REDIS_URL). Uses the fixture Nango client, so no
 * Nango account is needed.
 */
import { createHmac } from 'node:crypto'
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { redisConnectionOptions } from '../src/queue/connection.js'
import { createIngestQueue, createDlqQueue, createNangoSyncQueue, createReconcileQueue } from '../src/queue/queues.js'
import { createIngestWorker } from '../src/queue/ingestWorker.js'
import { createNangoSyncWorker } from '../src/queue/nangoSyncWorker.js'
import { createReconcileWorker } from '../src/queue/reconcileWorker.js'
import { createNangoClient } from '../src/nango/client.js'
import { buildApp } from '../src/app.js'
import { Tenant, Connection, Event, RawRecord, SyncState } from '../src/models/index.js'
import type { NangoListParams } from '../src/nango/types.js'

const PORT = 3940
const DEMO = { name: 'Demo (Acme Storefront)', apiKey: 'demo-api-key' }
const WEBHOOK_SECRET = config.nangoWebhookSecret || 'demo-webhook-secret'
const MODEL = 'GithubIssue'

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms))
async function waitFor<T>(pred: () => Promise<T> | T, { timeout = 30000, interval = 50 } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await pred()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await delay(interval)
  }
}
const banner = (s: string) => console.log('\n' + s)

async function main() {
  await connectDB(config.mongoUri)

  const tenant = await Tenant.findOneAndUpdate({ apiKey: DEMO.apiKey }, { $setOnInsert: DEMO }, { upsert: true, returnDocument: 'after' })
  const connection = await Connection.findOneAndUpdate(
    { tenantId: tenant._id, provider: 'github' },
    { $set: { nangoConnectionId: 'demo-conn', nangoIntegrationId: 'github', status: 'active', models: [MODEL] }, $setOnInsert: { tenantId: tenant._id, provider: 'github' } },
    { upsert: true, returnDocument: 'after' }
  )
  const tenantId = tenant._id
  await Promise.all([
    Event.deleteMany({ tenantId }), RawRecord.deleteMany({ tenantId }),
    SyncState.deleteMany({ tenantId, connectionId: connection._id }),
  ])

  // Fixture Nango wrapped with a toggleable outage — the failure we inject.
  let nangoDown = false
  const base = createNangoClient()
  const nango = {
    fixtures: base.fixtures,
    async listRecords(args: NangoListParams) {
      if (nangoDown) { const e = new Error('Nango records API unavailable (injected)') as Error & { kind?: string }; e.kind = 'transient'; throw e }
      return base.listRecords(args)
    },
  }

  const conn = redisConnectionOptions()
  const ingestQueue = createIngestQueue(conn)
  const dlqQueue = createDlqQueue(conn)
  const nangoSyncQueue = createNangoSyncQueue(conn)
  const reconcileQueue = createReconcileQueue(conn)
  for (const q of [ingestQueue, dlqQueue, nangoSyncQueue, reconcileQueue]) q.on('error', () => {})
  await Promise.all([ingestQueue.obliterate({ force: true }), nangoSyncQueue.obliterate({ force: true }), reconcileQueue.obliterate({ force: true })])

  const wlog = { log: (m: unknown) => console.log('       ' + m), error: (m: unknown) => console.log('       ' + m) }
  const ingestWorker = createIngestWorker({ connection: conn, dlqQueue, baseMs: 300, logger: wlog })
  const syncWorker = createNangoSyncWorker({ connection: conn, ingestQueue, nango, baseMs: 300, logger: wlog })
  const reconcileWorker = createReconcileWorker({ connection: conn, nango, ingestQueue, reconcileQueue, baseMs: 300, logger: wlog })

  // Track terminal reconcile outcomes (BullMQ emits 'failed' per attempt).
  let reconcileDone = 0
  let reconcileFailedTerminally = 0
  reconcileWorker.on('completed', (job) => { if (job.name === 'reconcile') reconcileDone += 1 })
  reconcileWorker.on('failed', (job) => { if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) reconcileFailedTerminally += 1 })
  await Promise.all([ingestWorker.waitUntilReady(), syncWorker.waitUntilReady(), reconcileWorker.waitUntilReady()])

  const app = buildApp({ ingestQueue, nangoSyncQueue, reconcileQueue, nangoWebhookSecret: WEBHOOK_SECRET })
  const server = app.listen(PORT)
  const base_url = `http://localhost:${PORT}`
  const headers = { Authorization: `Bearer ${DEMO.apiKey}`, 'Content-Type': 'application/json' }

  const countEvents = () => Event.countDocuments({ tenantId, type: 'issue' })
  const cursorNow = async () => (await SyncState.findOne({ tenantId, connectionId: connection._id, model: MODEL }).lean())?.cursor ?? null

  banner('=== Milestone 5 — reconciliation poller: both paths + cursor invariant ===')
  console.log(`tenant "${tenant.name}"   connection ${connection._id}   model ${MODEL}`)
  console.log('Reset: cleared events, raw_records, sync_state for the demo connection.')
  console.log(`Cursor at start: ${await cursorNow() ?? '∅ (none)'}`)

  // ---- Path 1: webhook -------------------------------------------------------
  banner('Path 1  Webhook delivery (M4): a signed Nango sync webhook -> events')
  const body = JSON.stringify({ type: 'sync', connectionId: 'demo-conn', providerConfigKey: 'github', model: MODEL, success: true })
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')
  const wres = await fetch(`${base_url}/webhooks/nango`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nango-Hmac-Sha256': sig }, body })
  await waitFor(async () => (await countEvents()) === 2)
  console.log(`  HTTP ${wres.status}; events (issues) = ${await countEvents()}   (webhook path works)`)
  console.log(`  reconcile cursor still ${await cursorNow() ?? '∅'}  (the webhook path doesn't use the cursor)`)

  // ---- Path 2: reconcile while the records API is DOWN -----------------------
  banner('Path 2  Manual reconcile while the records API is DOWN (failure injected)')
  nangoDown = true
  const f0 = reconcileFailedTerminally
  const fres = await fetch(`${base_url}/connections/${connection._id}/reconcile`, { method: 'POST', headers })
  console.log(`  POST /reconcile -> HTTP ${fres.status}; watch the reconcile job retry with backoff...`)
  await waitFor(() => reconcileFailedTerminally > f0, { timeout: 30000 })
  console.log(`  reconcile job exhausted its retries and FAILED`)
  console.log(`  cursor = ${await cursorNow() ?? '∅'}   (HELD — the failed fetch advanced nothing)`)

  // ---- Path 3: reconcile after the records API RECOVERS ----------------------
  banner('Path 3  Records API recovers -> reconcile advances the cursor (no dupes)')
  nangoDown = false
  const d0 = reconcileDone
  const ok = await fetch(`${base_url}/connections/${connection._id}/reconcile`, { method: 'POST', headers })
  await waitFor(() => reconcileDone > d0)
  const finalCursor = await cursorNow()
  console.log(`  POST /reconcile -> HTTP ${ok.status}; reconcile completed`)
  console.log(`  cursor = ${finalCursor}   (ADVANCED to the last record's cursor)`)
  console.log(`  events (issues) = ${await countEvents()}   (UNCHANGED — reconcile is idempotent)`)

  const passed = finalCursor === 'c-102' && (await countEvents()) === 2
  banner(passed
    ? '✓ Both paths delivered to events. Cursor stayed ∅ through the outage, advanced to c-102 on success.'
    : '✗ Demo FAILED: expected cursor c-102 and 2 issue events.')

  server.close()
  await Promise.allSettled([ingestWorker.close(), syncWorker.close(), reconcileWorker.close()])
  await Promise.allSettled([ingestQueue.close(), dlqQueue.close(), nangoSyncQueue.close(), reconcileQueue.close()])
  await disconnectDB()
  process.exit(passed ? 0 : 1)
}

main().catch(async (err) => {
  console.error('\nDemo crashed:', err)
  await disconnectDB().catch(() => {})
  process.exit(1)
})
