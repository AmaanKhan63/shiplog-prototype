import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { buildApp } from '../src/app.js'
import { Tenant, Event } from '../src/models/index.js'

let app
let tenantA
let tenantB

beforeAll(async () => {
  await connectTestDB()
  await Event.init()
  await Tenant.init()
  app = buildApp()
})
afterAll(dropAndClose)

beforeEach(async () => {
  await clearDB()
  tenantA = await Tenant.create({ name: 'Acme', apiKey: 'key-a' })
  tenantB = await Tenant.create({ name: 'Globex', apiKey: 'key-b' })
  await Event.create({
    tenantId: tenantA._id, idempotencyKey: 'k-a-1', type: 'issue', source: 'github',
    externalId: 'issue:1', contentHash: 'h', actor: 'octocat', title: 'A only',
    url: 'https://x/1', occurredAt: new Date(), version: 'v1',
  })
})

describe('GET /health', () => {
  it('is public and returns ok', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'ok' })
  })
})

describe('tenant API-key middleware', () => {
  it('rejects a request with no API key (401)', async () => {
    const res = await request(app).get('/events')
    expect(res.status).toBe(401)
  })

  it('rejects an unknown API key (401)', async () => {
    const res = await request(app).get('/events').set('Authorization', 'Bearer nope')
    expect(res.status).toBe(401)
  })

  it('accepts a valid key via Authorization: Bearer and resolves the tenant', async () => {
    const res = await request(app).get('/events').set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(200)
    expect(res.body.events).toHaveLength(1)
    expect(res.body.events[0].title).toBe('A only')
  })

  it('accepts a valid key via x-api-key header', async () => {
    const res = await request(app).get('/events').set('x-api-key', 'key-a')
    expect(res.status).toBe(200)
  })
})

describe('tenant isolation (foundation)', () => {
  it('does not leak tenant A events to tenant B', async () => {
    const res = await request(app).get('/events').set('Authorization', 'Bearer key-b')
    expect(res.status).toBe(200)
    expect(res.body.events).toHaveLength(0)
  })
})
