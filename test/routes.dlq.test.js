import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { buildApp } from '../src/app.js'
import { Tenant, DeadLetter } from '../src/models/index.js'
import { landRawRecord } from '../src/events/raw.js'
import { githubFixtures } from '../src/fixtures/github.js'

function fakeQueue() {
  const added = []
  return { added, add: async (name, data) => { added.push({ name, data }); return { id: `job-${added.length}` } } }
}

let app, queue, tenantA, tenantB

beforeAll(async () => { await connectTestDB(); await Promise.all([Tenant.syncIndexes(), DeadLetter.syncIndexes()]) })
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantA = await Tenant.create({ name: 'A', apiKey: 'key-a' })
  tenantB = await Tenant.create({ name: 'B', apiKey: 'key-b' })
  queue = fakeQueue()
  app = buildApp({ ingestQueue: queue })
})

const dlqDoc = (tenantId, extra = {}) =>
  DeadLetter.create({ tenantId, payload: { tenantId: String(tenantId), record: githubFixtures[0] }, errorMessage: 'x', attemptsMade: 5, failedAt: new Date(), ...extra })

describe('GET /dlq', () => {
  it('lists the tenant\'s dead_letter items', async () => {
    await dlqDoc(tenantA._id)
    const res = await request(app).get('/dlq').set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
  })

  it('does not leak another tenant\'s items', async () => {
    await dlqDoc(tenantA._id)
    const res = await request(app).get('/dlq').set('Authorization', 'Bearer key-b')
    expect(res.body.count).toBe(0)
  })
})

describe('POST /dlq/:id/replay', () => {
  it('replays the item, enqueues its payload, and marks it replayed', async () => {
    const dl = await dlqDoc(tenantA._id)
    const res = await request(app).post(`/dlq/${dl._id}/replay`).set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(200)
    expect(res.body.replayed).toBe(true)
    expect(queue.added).toHaveLength(1)
    expect((await DeadLetter.findById(dl._id)).replayedAt).toBeTruthy()
  })

  it('returns 404 for another tenant\'s item (isolation)', async () => {
    const dl = await dlqDoc(tenantA._id)
    const res = await request(app).post(`/dlq/${dl._id}/replay`).set('Authorization', 'Bearer key-b')
    expect(res.status).toBe(404)
    expect(queue.added).toHaveLength(0)
  })

  it('requires an API key', async () => {
    const res = await request(app).post(`/dlq/${new mongoose.Types.ObjectId()}/replay`)
    expect(res.status).toBe(401)
  })

  it('returns 503 when the app has no queue configured', async () => {
    const dl = await dlqDoc(tenantA._id)
    const res = await request(buildApp()).post(`/dlq/${dl._id}/replay`).set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(503)
  })
})

describe('POST /connections/:id/backfill', () => {
  it('reprocesses raw_records for the connection', async () => {
    const connectionId = new mongoose.Types.ObjectId()
    for (const r of githubFixtures.slice(0, 2)) await landRawRecord(r, { tenantId: tenantA._id, connectionId })
    const res = await request(app).post(`/connections/${connectionId}/backfill`).set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(200)
    expect(res.body.enqueued).toBe(2)
    expect(queue.added).toHaveLength(2)
  })
})
