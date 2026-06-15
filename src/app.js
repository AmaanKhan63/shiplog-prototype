import express from 'express'
import { tenantAuth } from './middleware/tenantAuth.js'
import { withTenant } from './repository/withTenant.js'
import { config } from './config/env.js'
import { Connection, DeadLetter } from './models/index.js'
import { replayDeadLetter, backfillConnection } from './queue/replay.js'
import { verifyNangoSignature, computeNangoHmac } from './nango/verify.js'
import { NANGO_SYNC_QUEUE } from './queue/queues.js'

/**
 * Build the Express app. Exported as a factory so tests can mount it with
 * supertest without binding a port.
 *
 * `ingestQueue` (replay/backfill) and `nangoSyncQueue` (webhooks) are BullMQ
 * producers; when omitted, the routes that need them respond 503.
 */
export function buildApp({ ingestQueue, nangoSyncQueue, nangoWebhookSecret = config.nangoWebhookSecret } = {}) {
  const app = express()

  // Public liveness probe.
  app.get('/health', (req, res) => res.json({ status: 'ok' }))

  // Nango webhook receiver — raw body, signature-authenticated. Registered BEFORE
  // the JSON parser (so the raw bytes survive for HMAC) and before tenantAuth.
  // Responds 2xx fast and enqueues a sync job; the worker fetches records.
  app.post('/webhooks/nango', express.raw({ type: '*/*' }), async (req, res, next) => {
    try {
      const rawBody = req.body // Buffer (express.raw)
      if (!verifyNangoSignature(rawBody, req.headers, nangoWebhookSecret)) {
        if (config.nangoDebug) {
          console.warn(`[nango] signature mismatch: received=${req.get('x-nango-hmac-sha256')} computed=${computeNangoHmac(rawBody, nangoWebhookSecret)}`)
        }
        return res.status(401).json({ error: 'Invalid signature' })
      }

      let payload
      try { payload = JSON.parse(Buffer.from(rawBody).toString('utf8')) } catch { return res.status(400).json({ error: 'Invalid JSON' }) }

      const isSync = payload.type === 'sync' || payload.type === 'sync.success'
      if (!isSync || payload.success === false) {
        return res.status(200).json({ ok: true, ignored: payload.type })
      }

      const connection = await Connection.findOne({ nangoConnectionId: payload.connectionId })
      if (!connection) return res.status(200).json({ ok: true, note: 'no matching connection' })
      if (!nangoSyncQueue) return res.status(503).json({ error: 'Queue not configured' })

      await nangoSyncQueue.add(NANGO_SYNC_QUEUE, {
        tenantId: String(connection.tenantId),
        connectionId: String(connection._id),
        nangoConnectionId: payload.connectionId,
        providerConfigKey: payload.providerConfigKey,
        model: payload.model,
        modifiedAfter: payload.modifiedAfter,
      })
      res.status(202).json({ ok: true, enqueued: true })
    } catch (err) {
      next(err)
    }
  })

  app.use(express.json())

  // Everything below requires a tenant API key.
  app.use(tenantAuth)

  // Register/update a connection and store its Nango connection id.
  app.post('/connections', async (req, res, next) => {
    try {
      const { nangoConnectionId, nangoIntegrationId, provider = 'github' } = req.body ?? {}
      if (!nangoConnectionId) return res.status(400).json({ error: 'nangoConnectionId is required' })
      const connection = await Connection.findOneAndUpdate(
        { tenantId: req.tenantId, nangoConnectionId },
        { $set: { nangoIntegrationId, provider, status: 'active' }, $setOnInsert: { tenantId: req.tenantId, nangoConnectionId } },
        { upsert: true, returnDocument: 'after' }
      )
      res.status(201).json({ id: connection._id, nangoConnectionId, provider })
    } catch (err) {
      next(err)
    }
  })

  // Tenant-scoped consumption API for the normalized event spine.
  app.get('/events', async (req, res, next) => {
    try {
      const { type } = req.query
      const filter = {}
      if (type) filter.type = type
      const events = await withTenant(req.tenantId)
        .events.find(filter)
        .sort({ occurredAt: -1 })
        .lean()
      res.json({ count: events.length, events })
    } catch (err) {
      next(err)
    }
  })

  // Inspect the tenant's dead-letter queue.
  app.get('/dlq', async (req, res, next) => {
    try {
      const items = await DeadLetter.find({ tenantId: req.tenantId }).sort({ failedAt: -1 }).limit(100).lean()
      res.json({ count: items.length, items })
    } catch (err) {
      next(err)
    }
  })

  // Replay a dead-lettered item — re-enqueue its original payload (same
  // idempotency key, so it can't duplicate).
  app.post('/dlq/:id/replay', async (req, res, next) => {
    try {
      if (!ingestQueue) return res.status(503).json({ error: 'Queue not configured' })
      const result = await replayDeadLetter(req.params.id, { ingestQueue, tenantId: req.tenantId })
      if (!result) return res.status(404).json({ error: 'Dead-letter item not found' })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // Backfill a connection by reprocessing its raw_records.
  app.post('/connections/:id/backfill', async (req, res, next) => {
    try {
      if (!ingestQueue) return res.status(503).json({ error: 'Queue not configured' })
      const result = await backfillConnection(req.params.id, { ingestQueue, tenantId: req.tenantId })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message })
  })

  return app
}
