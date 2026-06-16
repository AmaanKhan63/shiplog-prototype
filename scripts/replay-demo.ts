/**
 * Milestone 3 — failure -> DLQ -> replay -> no duplicate.
 *
 *   npm run replay-demo
 *
 * Self-contained: starts an in-process ingest worker + the HTTP API, then walks
 * the full sequence against the REAL endpoints, printing the proof at each step.
 * Requires MongoDB and Redis (REDIS_URL).
 */
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { redisConnectionOptions } from '../src/queue/connection.js'
import { createIngestQueue, createDlqQueue, INGEST_QUEUE } from '../src/queue/queues.js'
import { createIngestWorker } from '../src/queue/ingestWorker.js'
import { buildApp } from '../src/app.js'
import { Tenant, Connection, Event, DeadLetter, RawRecord, SyncRun } from '../src/models/index.js'
import { landRawRecord } from '../src/events/raw.js'
import { githubFixtures } from '../src/fixtures/github.js'
import type { FailMode } from '../src/queue/types.js'
import type { NangoRecord } from '../src/nango/types.js'

const PORT = 3939
const DEMO = { name: 'Demo (Acme Storefront)', apiKey: 'demo-api-key' }
const record = githubFixtures.find((r) => r._nango_metadata.model === 'GithubCommit') as unknown as NangoRecord // immutable commit

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms))
async function waitFor<T>(pred: () => T | Promise<T>, { timeout = 25000, interval = 50 } = {}) {
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
    { $setOnInsert: { tenantId: tenant._id, provider: 'github', nangoConnectionId: 'demo-conn', nangoIntegrationId: 'github', status: 'active' } },
    { upsert: true, returnDocument: 'after' }
  )
  const tenantId = tenant._id
  await Promise.all([
    Event.deleteMany({ tenantId }), DeadLetter.deleteMany({ tenantId }),
    RawRecord.deleteMany({ tenantId }), SyncRun.deleteMany({ tenantId }),
  ])

  let failMode: FailMode | null = null
  const conn = redisConnectionOptions()
  const ingestQueue = createIngestQueue(conn)
  const dlqQueue = createDlqQueue(conn)
  ingestQueue.on('error', () => {})
  dlqQueue.on('error', () => {})
  await ingestQueue.obliterate({ force: true })

  const completed = new Set()
  const workerLogger = { log: (m: string) => console.log('       ' + m), error: (m: string) => console.log('       ' + m) }
  const worker = createIngestWorker({ connection: conn, dlqQueue, baseMs: 500, logger: workerLogger, getFailMode: () => failMode })
  worker.on('completed', (job) => completed.add(job.id))
  await worker.waitUntilReady()

  const app = buildApp({ ingestQueue })
  const server = app.listen(PORT)
  const base = `http://localhost:${PORT}`
  const headers = { Authorization: `Bearer ${DEMO.apiKey}`, 'Content-Type': 'application/json' }

  const payload = { tenantId: String(tenantId), connectionId: String(connection._id), record }
  const countEvents = () => Event.countDocuments({ tenantId })

  banner('=== Milestone 3 — failure -> DLQ -> replay -> no duplicate ===')
  console.log(`Record: ${record._nango_metadata!.model} ${record.sha}   tenant "${tenant.name}"`)
  console.log('Reset: cleared events, dead_letter, raw_records, sync_runs for the demo tenant.')
  await landRawRecord(record, { tenantId, connectionId: connection._id })

  banner('Step 1  Ingest the record through the queue (worker healthy)')
  failMode = null
  const job1 = await ingestQueue.add(INGEST_QUEUE, payload)
  await waitFor(() => completed.has(job1.id))
  const baseline = (await Event.findOne({ tenantId }).lean())!
  console.log(`  event stored   _id            = ${baseline._id}`)
  console.log(`                 idempotencyKey = ${baseline.idempotencyKey}`)
  console.log(`                 events = ${await countEvents()}`)

  banner('Step 2  Simulate a downstream outage and re-send the SAME record (failure ON)')
  failMode = 'transient'
  await ingestQueue.add(INGEST_QUEUE, payload)
  const dl = await waitFor(() => DeadLetter.findOne({ tenantId, attemptsMade: 5 }).lean())
  console.log(`  dead-lettered after ${dl.attemptsMade} attempts   id = ${dl._id}`)
  console.log(`                 events = ${await countEvents()}   (unchanged — the failed attempt wrote nothing)`)

  banner('Step 3  Resolve the outage (failure OFF)')
  failMode = null
  console.log('  downstream healthy again')

  banner(`Step 4  POST /dlq/${dl._id}/replay   (re-enqueues the original payload verbatim)`)
  const res = await fetch(`${base}/dlq/${dl._id}/replay`, { method: 'POST', headers })
  const body = (await res.json()) as { jobId: string }
  await waitFor(() => completed.has(body.jobId))
  const after = (await Event.findOne({ tenantId }).lean())!
  const sameRow = String(after._id) === String(baseline._id)
  const sameKey = after.idempotencyKey === baseline.idempotencyKey
  console.log(`  HTTP ${res.status}; replayed job processed`)
  console.log(`                 _id            = ${after._id}   ${sameRow ? '(SAME row)' : '(DIFFERENT row!)'}`)
  console.log(`                 idempotencyKey = ${after.idempotencyKey}   ${sameKey ? '(SAME key)' : '(DIFFERENT key!)'}`)
  console.log(`                 events = ${await countEvents()}   (UNCHANGED — no duplicate)`)

  banner(`Step 5  POST /connections/${connection._id}/backfill   (reprocess from raw_records)`)
  const bres = await fetch(`${base}/connections/${connection._id}/backfill`, { method: 'POST', headers })
  const bbody = (await bres.json()) as { enqueued: number }
  await waitFor(async () => {
    const c = await ingestQueue.getJobCounts('active', 'waiting', 'delayed')
    return c.active + c.waiting + c.delayed === 0
  })
  console.log(`  HTTP ${bres.status}; re-enqueued ${bbody.enqueued} raw record(s)`)
  console.log(`                 events = ${await countEvents()}   (UNCHANGED — backfill is idempotent too)`)

  const finalCount = await countEvents()
  const ok = sameRow && sameKey && finalCount === 1
  banner(ok
    ? '✓ Replay used the same idempotency key and created no duplicate. One event, same row.'
    : '✗ Demo FAILED: replay/backfill did not preserve the single event row.')

  server.close()
  await worker.close()
  await ingestQueue.close()
  await dlqQueue.close()
  await disconnectDB()
  process.exit(ok ? 0 : 1)
}

main().catch(async (err) => {
  console.error('\nDemo crashed:', err)
  await disconnectDB().catch(() => {})
  process.exit(1)
})
