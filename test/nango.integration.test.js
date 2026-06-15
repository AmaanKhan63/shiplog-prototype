import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import IORedis from 'ioredis'
import { createHmac } from 'node:crypto'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { Tenant, Connection, Event } from '../src/models/index.js'
import { createIngestQueue, createDlqQueue, createNangoSyncQueue } from '../src/queue/queues.js'
import { createIngestWorker } from '../src/queue/ingestWorker.js'
import { createNangoSyncWorker } from '../src/queue/nangoSyncWorker.js'
import { createNangoClient } from '../src/nango/client.js'
import { buildApp } from '../src/app.js'
import { redisConnectionOptions } from '../src/queue/connection.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const SECRET = 'whsec_integration'
const silent = { log() {}, error() {} }

async function redisReachable() {
  const r = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: false, retryStrategy: () => null })
  r.on('error', () => {})
  try { await r.connect(); await r.ping(); return true } catch { return false } finally { await r.quit().catch(() => {}) }
}
const available = await redisReachable()
const delay = (ms) => new Promise((res) => setTimeout(res, ms))
async function waitFor(pred, { timeout = 15000, interval = 50 } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await pred()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error('waitFor timed out')
    await delay(interval)
  }
}

describe.skipIf(!available)('Nango webhook -> records -> events (live Redis, fixture Nango)', () => {
  let ingestQueue, dlqQueue, nangoSyncQueue, ingestWorker, syncWorker, app

  beforeAll(async () => {
    await connectTestDB()
    await Promise.all([Tenant.syncIndexes(), Connection.syncIndexes(), Event.syncIndexes()])
    const connection = redisConnectionOptions()
    ingestQueue = createIngestQueue(connection)
    dlqQueue = createDlqQueue(connection)
    nangoSyncQueue = createNangoSyncQueue(connection)
    for (const e of [ingestQueue, dlqQueue, nangoSyncQueue]) e.on('error', () => {})
    ingestWorker = createIngestWorker({ connection, dlqQueue, baseMs: 20, logger: silent })
    syncWorker = createNangoSyncWorker({ connection, ingestQueue, nango: createNangoClient(), baseMs: 20, logger: silent })
    await Promise.all([ingestWorker.waitUntilReady(), syncWorker.waitUntilReady()])
    await Promise.all([ingestQueue.obliterate({ force: true }), nangoSyncQueue.obliterate({ force: true })])
    app = buildApp({ ingestQueue, nangoSyncQueue, nangoWebhookSecret: SECRET })
  })

  afterAll(async () => {
    await Promise.allSettled([ingestWorker?.close(), syncWorker?.close()])
    await delay(100)
    await Promise.allSettled([ingestQueue?.close(), dlqQueue?.close(), nangoSyncQueue?.close()])
    await dropAndClose()
  })

  function postWebhook(payloadObj) {
    const body = JSON.stringify(payloadObj)
    const sig = createHmac('sha256', SECRET).update(body).digest('hex')
    return request(app).post('/webhooks/nango').set('Content-Type', 'application/json').set('X-Nango-Hmac-Sha256', sig).send(body)
  }

  it('flows a signed sync webhook through to normalized events', async () => {
    await clearDB()
    const tenant = await Tenant.create({ name: 'Acme', apiKey: 'key-a' })
    await Connection.create({ tenantId: tenant._id, provider: 'github', nangoConnectionId: 'nc-1', nangoIntegrationId: 'github' })

    const res = await postWebhook({ type: 'sync', connectionId: 'nc-1', providerConfigKey: 'github', model: 'GithubIssue', success: true, responseResults: { added: 2, updated: 0, deleted: 0 } })
    expect(res.status).toBeGreaterThanOrEqual(200)
    expect(res.status).toBeLessThan(300)

    // fixture Nango returns the 2 GithubIssue fixtures -> 2 issue events
    await waitFor(async () => (await Event.countDocuments({ tenantId: tenant._id, type: 'issue' })) === 2)

    // A duplicated webhook is harmless — idempotent ingest, no new events.
    await postWebhook({ type: 'sync', connectionId: 'nc-1', providerConfigKey: 'github', model: 'GithubIssue', success: true })
    await delay(500)
    expect(await Event.countDocuments({ tenantId: tenant._id })).toBe(2)
  })
})
