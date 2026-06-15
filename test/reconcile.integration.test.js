import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import IORedis from 'ioredis'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { Tenant, Connection, Event, SyncState } from '../src/models/index.js'
import { createIngestQueue, createDlqQueue, createReconcileQueue } from '../src/queue/queues.js'
import { createIngestWorker } from '../src/queue/ingestWorker.js'
import { createReconcileWorker, scheduleReconcileSweep } from '../src/queue/reconcileWorker.js'
import { createNangoClient } from '../src/nango/client.js'
import { buildApp } from '../src/app.js'
import { redisConnectionOptions } from '../src/queue/connection.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
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

describe.skipIf(!available)('reconciliation poller (live Redis, fixture Nango)', () => {
  let ingestQueue, dlqQueue, reconcileQueue, ingestWorker, reconcileWorker, app
  const reconciled = []
  const swept = []

  beforeAll(async () => {
    await connectTestDB()
    await Promise.all([Tenant.syncIndexes(), Connection.syncIndexes(), Event.syncIndexes(), SyncState.syncIndexes()])
    const connection = redisConnectionOptions()
    ingestQueue = createIngestQueue(connection)
    dlqQueue = createDlqQueue(connection)
    reconcileQueue = createReconcileQueue(connection)
    for (const q of [ingestQueue, dlqQueue, reconcileQueue]) q.on('error', () => {})
    ingestWorker = createIngestWorker({ connection, dlqQueue, baseMs: 20, logger: silent })
    reconcileWorker = createReconcileWorker({ connection, nango: createNangoClient(), ingestQueue, reconcileQueue, baseMs: 20, logger: silent })
    reconcileWorker.on('completed', (job) => (job.name === 'sweep' ? swept : reconciled).push(job.id))
    await Promise.all([ingestWorker.waitUntilReady(), reconcileWorker.waitUntilReady()])
    await Promise.all([ingestQueue.obliterate({ force: true }), reconcileQueue.obliterate({ force: true })])
    app = buildApp({ ingestQueue, reconcileQueue })
  })

  afterAll(async () => {
    await reconcileQueue?.removeJobScheduler('reconcile-sweep').catch(() => {})
    await Promise.allSettled([ingestWorker?.close(), reconcileWorker?.close()])
    await delay(100)
    await Promise.allSettled([ingestQueue?.close(), dlqQueue?.close(), reconcileQueue?.close()])
    await dropAndClose()
  })

  it('manual POST /reconcile pulls records to events and advances the cursor; re-triggering is idempotent', async () => {
    await clearDB()
    const tenant = await Tenant.create({ name: 'Acme', apiKey: 'key-a' })
    const conn = await Connection.create({ tenantId: tenant._id, provider: 'github', nangoConnectionId: 'nc-1', nangoIntegrationId: 'github', models: ['GithubIssue'] })

    const c0 = reconciled.length
    const res = await request(app).post(`/connections/${conn._id}/reconcile`).set('Authorization', 'Bearer key-a')
    expect(res.status).toBe(202)

    await waitFor(() => reconciled.length > c0) // first reconcile job ran
    await waitFor(async () => (await Event.countDocuments({ tenantId: tenant._id, type: 'issue' })) === 2)
    const state = await SyncState.findOne({ tenantId: tenant._id, connectionId: conn._id, model: 'GithubIssue' }).lean()
    expect(state.cursor).toBe('c-102') // advanced to the last fixture's cursor

    // Re-trigger: the deterministic jobId frees after completion, so it runs
    // AGAIN (proving re-triggerability) but produces no duplicate events.
    const c1 = reconciled.length
    await request(app).post(`/connections/${conn._id}/reconcile`).set('Authorization', 'Bearer key-a')
    await waitFor(() => reconciled.length > c1)
    await delay(300)
    expect(await Event.countDocuments({ tenantId: tenant._id })).toBe(2)
    expect((await SyncState.findOne({ tenantId: tenant._id, connectionId: conn._id, model: 'GithubIssue' }).lean()).cursor).toBe('c-102')
  })

  it('the repeatable sweep fires on its own and reconciles active connections', async () => {
    await clearDB()
    const tenant = await Tenant.create({ name: 'Beta', apiKey: 'key-b' })
    await Connection.create({ tenantId: tenant._id, provider: 'github', nangoConnectionId: 'nc-2', nangoIntegrationId: 'github', models: ['GithubIssue'] })
    await reconcileQueue.obliterate({ force: true })

    const s0 = swept.length
    await scheduleReconcileSweep(reconcileQueue, { every: 300 }) // default-immediate first fire

    await waitFor(() => swept.length > s0) // a sweep ran with NO manual trigger
    await waitFor(async () => (await Event.countDocuments({ tenantId: tenant._id, type: 'issue' })) === 2)

    const schedulers = await reconcileQueue.getJobSchedulers()
    expect(schedulers.length).toBeGreaterThanOrEqual(1)

    await reconcileQueue.removeJobScheduler('reconcile-sweep') // stop it before teardown
  })
})
