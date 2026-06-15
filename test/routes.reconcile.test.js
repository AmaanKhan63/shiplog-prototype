import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { buildApp } from '../src/app.js'
import { Tenant, Connection } from '../src/models/index.js'

function fakeQueue() {
  const added = []
  return { added, add: async (name, data, opts) => { added.push({ name, data, opts }); return { id: opts?.jobId ?? `j${added.length}` } } }
}

let app, queue, tenantA, tenantB, connA

beforeAll(async () => { await connectTestDB(); await Promise.all([Tenant.syncIndexes(), Connection.syncIndexes()]) })
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantA = await Tenant.create({ name: 'A', apiKey: 'key-a' })
  tenantB = await Tenant.create({ name: 'B', apiKey: 'key-b' })
  connA = await Connection.create({ tenantId: tenantA._id, provider: 'github', nangoConnectionId: 'nc-a', nangoIntegrationId: 'github', models: ['GithubIssue', 'GithubPullRequest'] })
  queue = fakeQueue()
  app = buildApp({ reconcileQueue: queue })
})

describe('POST /connections/:id/reconcile', () => {
  it('enqueues a reconcile job per model on the connection and returns 202', async () => {
    const res = await request(app).post(`/connections/${connA._id}/reconcile`).set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(202)
    expect(res.body.enqueued).toBe(2)
    expect(queue.added).toHaveLength(2)
    expect(queue.added[0].name).toBe('reconcile')
    expect(queue.added.map((j) => j.data.model).sort()).toEqual(['GithubIssue', 'GithubPullRequest'])
  })

  it('reconciles a single model when one is given in the body', async () => {
    const res = await request(app).post(`/connections/${connA._id}/reconcile`).set('Authorization', 'Bearer key-a').send({ model: 'GithubIssue' })
    expect(res.status).toBe(202)
    expect(queue.added).toHaveLength(1)
    expect(queue.added[0].data.model).toBe('GithubIssue')
  })

  it('returns 404 for another tenant\'s connection (isolation)', async () => {
    const res = await request(app).post(`/connections/${connA._id}/reconcile`).set('Authorization', 'Bearer key-b')
    expect(res.status).toBe(404)
    expect(queue.added).toHaveLength(0)
  })

  it('returns 404 for an unknown connection', async () => {
    const res = await request(app).post(`/connections/${new mongoose.Types.ObjectId()}/reconcile`).set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(404)
  })

  it('returns 400 for a malformed connection id (not a 500)', async () => {
    const res = await request(app).post('/connections/not-an-object-id/reconcile').set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(400)
    expect(queue.added).toHaveLength(0)
  })

  it('returns 400 when model is not a string', async () => {
    const res = await request(app).post(`/connections/${connA._id}/reconcile`).set('Authorization', 'Bearer key-a').send({ model: { nested: true } })
    expect(res.status).toBe(400)
    expect(queue.added).toHaveLength(0)
  })

  it('requires an API key', async () => {
    const res = await request(app).post(`/connections/${connA._id}/reconcile`)
    expect(res.status).toBe(401)
  })

  it('returns 503 when no reconcile queue is configured', async () => {
    const res = await request(buildApp()).post(`/connections/${connA._id}/reconcile`).set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(503)
  })
})
