import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import IORedis from 'ioredis'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { Event, DeadLetter } from '../src/models/index.js'
import { createIngestQueue, createDlqQueue } from '../src/queue/queues.js'
import { createIngestWorker } from '../src/queue/ingestWorker.js'
import { redisConnectionOptions } from '../src/queue/connection.js'
import { githubFixtures } from '../src/fixtures/github.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

async function redisReachable() {
  const r = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: false, retryStrategy: () => null })
  r.on('error', () => {})
  try { await r.connect(); await r.ping(); return true } catch { return false } finally { await r.quit().catch(() => {}) }
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms))

const available = await redisReachable()
const silent = { log() {}, error() {} }

async function waitFor(predicate, { timeout = 10000, interval = 40 } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await predicate()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await new Promise((res) => setTimeout(res, interval))
  }
}

describe.skipIf(!available)('BullMQ ingest pipeline (live Redis)', () => {
  let ingestQueue, dlqQueue, worker

  beforeAll(async () => {
    await connectTestDB()
    await Promise.all([Event.syncIndexes(), DeadLetter.syncIndexes()])
    // BullMQ owns each connection (created from options), so .close() fully tears
    // them down — no externally-held instance to race on teardown.
    const connection = redisConnectionOptions()
    ingestQueue = createIngestQueue(connection)
    dlqQueue = createDlqQueue(connection)
    // tiny baseMs keeps the 4 retry delays fast (~20+40+80+160ms)
    worker = createIngestWorker({ connection, dlqQueue, baseMs: 20, logger: silent })
    // Swallow benign 'error' events so an unhandled emitter error can't crash the run.
    for (const emitter of [ingestQueue, dlqQueue]) emitter.on('error', () => {})
    await worker.waitUntilReady()
    await ingestQueue.obliterate({ force: true })
  })

  afterAll(async () => {
    // Stop processing first, let any in-flight failed-handlers settle, then let
    // BullMQ close its own connections.
    await worker?.close()
    await delay(100)
    await Promise.allSettled([ingestQueue?.close(), dlqQueue?.close()])
    await dropAndClose()
  })

  beforeEach(clearDB)

  it('processes a healthy record end-to-end into the event spine', async () => {
    const tenantId = new mongoose.Types.ObjectId()
    await ingestQueue.add('ingest', { tenantId, record: githubFixtures[0] })
    await waitFor(async () => (await Event.countDocuments({ tenantId })) === 1)
    expect(await DeadLetter.countDocuments({ tenantId })).toBe(0)
  })

  it('retries a transient failure 5 times then writes exactly one DLQ doc', async () => {
    const tenantId = new mongoose.Types.ObjectId()
    await ingestQueue.add('ingest', { tenantId, record: githubFixtures[0], poison: 'transient' })

    const doc = await waitFor(async () => DeadLetter.findOne({ tenantId }).lean())
    expect(await DeadLetter.countDocuments({ tenantId })).toBe(1)
    expect(doc.attemptsMade).toBe(5)
    expect(await Event.countDocuments({ tenantId })).toBe(0)
  })

  it('sends a logical failure straight to the DLQ with no retry', async () => {
    const tenantId = new mongoose.Types.ObjectId()
    await ingestQueue.add('ingest', { tenantId, record: githubFixtures[0], poison: 'logical' })

    const doc = await waitFor(async () => DeadLetter.findOne({ tenantId }).lean())
    expect(await DeadLetter.countDocuments({ tenantId })).toBe(1)
    expect(doc.attemptsMade).toBe(1)
  })
})
