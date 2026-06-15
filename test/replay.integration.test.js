import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mongoose from 'mongoose'
import IORedis from 'ioredis'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { Event, DeadLetter } from '../src/models/index.js'
import { createIngestQueue, createDlqQueue, INGEST_QUEUE } from '../src/queue/queues.js'
import { createIngestWorker } from '../src/queue/ingestWorker.js'
import { replayDeadLetter, backfillConnection } from '../src/queue/replay.js'
import { redisConnectionOptions } from '../src/queue/connection.js'
import { landRawRecord } from '../src/events/raw.js'
import { githubFixtures } from '../src/fixtures/github.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const silent = { log() {}, error() {} }

async function redisReachable() {
  const r = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: false, retryStrategy: () => null })
  r.on('error', () => {})
  try { await r.connect(); await r.ping(); return true } catch { return false } finally { await r.quit().catch(() => {}) }
}
const available = await redisReachable()
const delay = (ms) => new Promise((res) => setTimeout(res, ms))

async function waitFor(predicate, { timeout = 10000, interval = 40 } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await predicate()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await delay(interval)
  }
}

describe.skipIf(!available)('failure -> DLQ -> replay -> no duplicate (live Redis)', () => {
  let ingestQueue, dlqQueue, worker, failMode
  const completed = new Set()

  beforeAll(async () => {
    await connectTestDB()
    await Promise.all([Event.syncIndexes(), DeadLetter.syncIndexes()])
    const connection = redisConnectionOptions()
    ingestQueue = createIngestQueue(connection)
    dlqQueue = createDlqQueue(connection)
    failMode = null
    worker = createIngestWorker({ connection, dlqQueue, baseMs: 20, logger: silent, getFailMode: () => failMode })
    worker.on('completed', (job) => completed.add(job.id))
    for (const e of [ingestQueue, dlqQueue]) e.on('error', () => {})
    await worker.waitUntilReady()
    await ingestQueue.obliterate({ force: true })
  })

  afterAll(async () => {
    await worker?.close()
    await delay(100)
    await Promise.allSettled([ingestQueue?.close(), dlqQueue?.close()])
    await dropAndClose()
  })

  it('replays the dead-lettered record onto the SAME event row, count unchanged', async () => {
    await clearDB()
    const tenantId = new mongoose.Types.ObjectId()
    const connectionId = new mongoose.Types.ObjectId()
    const payload = { tenantId: String(tenantId), connectionId: String(connectionId), record: githubFixtures[0] }

    // 1) Baseline ingest succeeds.
    failMode = null
    await ingestQueue.add(INGEST_QUEUE, payload)
    await waitFor(async () => (await Event.countDocuments({ tenantId })) === 1)
    const baseline = await Event.findOne({ tenantId }).lean()

    // 2) Outage: same record fails all attempts and lands in the DLQ.
    failMode = 'transient'
    await ingestQueue.add(INGEST_QUEUE, payload)
    const dl = await waitFor(async () => DeadLetter.findOne({ tenantId, attemptsMade: 5 }).lean())

    // 3) Recover, then replay the dead-lettered payload (verbatim).
    failMode = null
    const result = await replayDeadLetter(dl._id, { ingestQueue, tenantId })
    await waitFor(() => completed.has(result.jobId))

    // 4) Proof: same row (_id + idempotencyKey), still exactly one event.
    const after = await Event.findOne({ tenantId }).lean()
    expect(await Event.countDocuments({ tenantId })).toBe(1)
    expect(String(after._id)).toBe(String(baseline._id))
    expect(after.idempotencyKey).toBe(baseline.idempotencyKey)
    expect((await DeadLetter.findById(dl._id).lean()).replayedAt).toBeTruthy()
  })

  it('backfill reprocesses raw_records without duplicating', async () => {
    await clearDB()
    const tenantId = new mongoose.Types.ObjectId()
    const connectionId = new mongoose.Types.ObjectId()
    const records = githubFixtures.slice(0, 3)
    for (const r of records) await landRawRecord(r, { tenantId, connectionId })

    // Ingest once directly, then backfill from raw — every backfilled job is a no-op.
    for (const record of records) await ingestQueue.add(INGEST_QUEUE, { tenantId: String(tenantId), connectionId: String(connectionId), record })
    await waitFor(async () => (await Event.countDocuments({ tenantId })) === records.length)

    const { enqueued } = await backfillConnection(connectionId, { ingestQueue, tenantId })
    expect(enqueued).toBe(records.length)
    // Wait for the backfilled jobs to drain.
    await waitFor(async () => {
      const c = await ingestQueue.getJobCounts('active', 'waiting', 'delayed')
      return c.active + c.waiting + c.delayed === 0
    })
    expect(await Event.countDocuments({ tenantId })).toBe(records.length)
  })
})
