import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import mongoose from 'mongoose'
import { createHmac } from 'node:crypto'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { buildApp } from '../src/app.js'
import { Tenant, Connection } from '../src/models/index.js'

const SECRET = 'whsec_test_abc'

function fakeQueue() {
  const added = []
  return { added, add: async (name, data) => { added.push({ name, data }); return { id: `j${added.length}` } } }
}

let app, ingestQueue, nangoSyncQueue, tenant

beforeAll(async () => { await connectTestDB(); await Promise.all([Tenant.syncIndexes(), Connection.syncIndexes()]) })
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenant = await Tenant.create({ name: 'Acme', apiKey: 'key-a' })
  ingestQueue = fakeQueue()
  nangoSyncQueue = fakeQueue()
  app = buildApp({ ingestQueue, nangoSyncQueue, nangoWebhookSecret: SECRET })
})

function signed(payloadObj, secret = SECRET) {
  const body = JSON.stringify(payloadObj)
  const sig = createHmac('sha256', secret).update(body).digest('hex')
  return request(app).post('/webhooks/nango').set('Content-Type', 'application/json').set('X-Nango-Hmac-Sha256', sig).send(body)
}

const syncPayload = (over = {}) => ({
  type: 'sync', connectionId: 'nango-conn-1', providerConfigKey: 'github', syncName: 'github-issues',
  model: 'GithubIssue', syncType: 'INCREMENTAL', success: true, modifiedAfter: '2024-03-01T00:00:00Z',
  responseResults: { added: 2, updated: 0, deleted: 0 }, ...over,
})

describe('POST /webhooks/nango', () => {
  it('verifies the signature and enqueues a sync job for a matching connection', async () => {
    await Connection.create({ tenantId: tenant._id, provider: 'github', nangoConnectionId: 'nango-conn-1', nangoIntegrationId: 'github' })
    const res = await signed(syncPayload())
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)
    expect(nangoSyncQueue.added).toHaveLength(1)
    expect(nangoSyncQueue.added[0].data).toMatchObject({
      tenantId: String(tenant._id), nangoConnectionId: 'nango-conn-1',
      providerConfigKey: 'github', model: 'GithubIssue', modifiedAfter: '2024-03-01T00:00:00Z',
    })
  })

  it('rejects an invalid signature with 401 and enqueues nothing', async () => {
    await Connection.create({ tenantId: tenant._id, nangoConnectionId: 'nango-conn-1' })
    const body = JSON.stringify(syncPayload())
    const res = await request(app).post('/webhooks/nango').set('Content-Type', 'application/json').set('X-Nango-Hmac-Sha256', 'deadbeef').send(body)
    expect(res.status).toBe(401)
    expect(nangoSyncQueue.added).toHaveLength(0)
  })

  it('ignores non-sync notifications (2xx, no enqueue)', async () => {
    await Connection.create({ tenantId: tenant._id, nangoConnectionId: 'nango-conn-1' })
    const res = await signed(syncPayload({ type: 'auth', operation: 'CREATION' }))
    expect(res.status).toBe(200)
    expect(nangoSyncQueue.added).toHaveLength(0)
  })

  it('ignores a webhook for an unknown connection (2xx, no enqueue)', async () => {
    const res = await signed(syncPayload({ connectionId: 'unknown-conn' }))
    expect(res.status).toBe(200)
    expect(nangoSyncQueue.added).toHaveLength(0)
  })

  it('does not enqueue a failed sync', async () => {
    await Connection.create({ tenantId: tenant._id, nangoConnectionId: 'nango-conn-1' })
    const res = await signed(syncPayload({ success: false }))
    expect(res.status).toBe(200)
    expect(nangoSyncQueue.added).toHaveLength(0)
  })
})

describe('POST /connections', () => {
  it('stores the nangoConnectionId on a connection for the tenant', async () => {
    const res = await request(app).post('/connections').set('Authorization', 'Bearer key-a')
      .send({ nangoConnectionId: 'nango-conn-1', nangoIntegrationId: 'github' })
    expect(res.status).toBe(201)
    const stored = await Connection.findOne({ tenantId: tenant._id, nangoConnectionId: 'nango-conn-1' })
    expect(stored).toBeTruthy()
    expect(stored.nangoIntegrationId).toBe('github')
  })

  it('requires nangoConnectionId', async () => {
    const res = await request(app).post('/connections').set('Authorization', 'Bearer key-a').send({})
    expect(res.status).toBe(400)
  })

  it('requires an API key', async () => {
    const res = await request(app).post('/connections').send({ nangoConnectionId: 'x' })
    expect(res.status).toBe(401)
  })
})
