import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { buildApp } from '../src/app.js'
import { Tenant, Connection, SyncRun } from '../src/models/index.js'
import type { TenantDoc } from '../src/models/Tenant.js'

let app: ReturnType<typeof buildApp>, tenantA: TenantDoc, tenantB: TenantDoc

beforeAll(async () => {
  await connectTestDB()
  await Promise.all([Tenant.syncIndexes(), Connection.syncIndexes(), SyncRun.syncIndexes()])
})
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantA = await Tenant.create({ name: 'A', apiKey: 'key-a' })
  tenantB = await Tenant.create({ name: 'B', apiKey: 'key-b' })
  app = buildApp()
})

describe('GET /connections', () => {
  it("lists the tenant's connections", async () => {
    await Connection.create({ tenantId: tenantA._id, provider: 'github', nangoConnectionId: 'nc-a', models: ['GithubIssue'] })
    const res = await request(app).get('/connections').set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(1)
    expect(res.body.connections[0].nangoConnectionId).toBe('nc-a')
    expect(res.body.connections[0].models).toEqual(['GithubIssue'])
  })

  it("does not leak another tenant's connections (isolation)", async () => {
    await Connection.create({ tenantId: tenantA._id, provider: 'github', nangoConnectionId: 'nc-a', models: ['GithubIssue'] })
    const res = await request(app).get('/connections').set('Authorization', 'Bearer key-b')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
    expect(res.body.connections).toEqual([])
  })

  it('requires an API key', async () => {
    const res = await request(app).get('/connections')
    expect(res.status).toBe(401)
  })
})

describe('GET /sync-runs', () => {
  it("lists the tenant's sync runs, newest first", async () => {
    await SyncRun.create({ tenantId: tenantA._id, trigger: 'reconcile', status: 'success', counts: { added: 3, updated: 1, deleted: 0, failed: 0 } })
    await SyncRun.create({ tenantId: tenantA._id, trigger: 'webhook', status: 'running', counts: { added: 0, updated: 0, deleted: 0, failed: 0 } })
    const res = await request(app).get('/sync-runs').set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    // newest first: the 'webhook' run was created last
    expect(res.body.runs[0].trigger).toBe('webhook')
    expect(res.body.runs[1].trigger).toBe('reconcile')
    expect(res.body.runs[1].counts).toMatchObject({ added: 3, updated: 1, deleted: 0, failed: 0 })
  })

  it("does not leak another tenant's sync runs (isolation)", async () => {
    await SyncRun.create({ tenantId: tenantA._id, trigger: 'reconcile', status: 'success' })
    const res = await request(app).get('/sync-runs').set('Authorization', 'Bearer key-b')
    expect(res.status).toBe(200)
    expect(res.body.count).toBe(0)
    expect(res.body.runs).toEqual([])
  })

  it('requires an API key', async () => {
    const res = await request(app).get('/sync-runs')
    expect(res.status).toBe(401)
  })
})
