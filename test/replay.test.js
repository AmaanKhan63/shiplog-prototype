import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { DeadLetter } from '../src/models/index.js'
import { replayDeadLetter, backfillConnection } from '../src/queue/replay.js'
import { landRawRecord } from '../src/events/raw.js'
import { githubFixtures } from '../src/fixtures/github.js'

let tenantId, connectionId

// Minimal fake queue that records what was enqueued (no Redis in the default suite).
function fakeQueue() {
  const added = []
  return { added, add: async (name, data) => { added.push({ name, data }); return { id: `job-${added.length}` } } }
}

beforeAll(async () => { await connectTestDB(); await Promise.all([DeadLetter.syncIndexes()]) })
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantId = new mongoose.Types.ObjectId()
  connectionId = new mongoose.Types.ObjectId()
})

describe('replayDeadLetter', () => {
  async function seedDLQ(payload) {
    return DeadLetter.create({ tenantId, connectionId, payload, errorMessage: 'boom', attemptsMade: 5, failedAt: new Date() })
  }

  it('re-enqueues the original payload verbatim and marks the item replayed', async () => {
    const payload = { tenantId: String(tenantId), connectionId: String(connectionId), record: githubFixtures[0] }
    const dl = await seedDLQ(payload)
    const queue = fakeQueue()

    const result = await replayDeadLetter(dl._id, { ingestQueue: queue, tenantId })

    expect(queue.added).toHaveLength(1)
    expect(queue.added[0].data).toEqual(payload) // verbatim -> same idempotency key
    expect(result.replayed).toBe(true)
    const reloaded = await DeadLetter.findById(dl._id).lean()
    expect(reloaded.replayedAt).toBeInstanceOf(Date)
  })

  it('does not replay another tenant\'s DLQ item (returns null, enqueues nothing)', async () => {
    const dl = await seedDLQ({ record: githubFixtures[0] })
    const queue = fakeQueue()
    const result = await replayDeadLetter(dl._id, { ingestQueue: queue, tenantId: new mongoose.Types.ObjectId() })
    expect(result).toBeNull()
    expect(queue.added).toHaveLength(0)
  })
})

describe('backfillConnection', () => {
  it('re-enqueues one ingest job per raw_record for the connection', async () => {
    for (const r of githubFixtures.slice(0, 3)) await landRawRecord(r, { tenantId, connectionId })
    const queue = fakeQueue()

    const result = await backfillConnection(connectionId, { ingestQueue: queue, tenantId })

    expect(result.enqueued).toBe(3)
    expect(queue.added).toHaveLength(3)
    expect(queue.added[0].data).toMatchObject({ tenantId: String(tenantId), connectionId: String(connectionId) })
    expect(queue.added[0].data.record).toBeTruthy()
  })

  it('only backfills the requesting tenant\'s raw records', async () => {
    await landRawRecord(githubFixtures[0], { tenantId, connectionId })
    const queue = fakeQueue()
    const result = await backfillConnection(connectionId, { ingestQueue: queue, tenantId: new mongoose.Types.ObjectId() })
    expect(result.enqueued).toBe(0)
    expect(queue.added).toHaveLength(0)
  })
})
