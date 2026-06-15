import express from 'express'
import { tenantAuth } from './middleware/tenantAuth.js'
import { withTenant } from './repository/withTenant.js'
import { DeadLetter } from './models/index.js'
import { replayDeadLetter, backfillConnection } from './queue/replay.js'

/**
 * Build the Express app. Exported as a factory so tests can mount it with
 * supertest without binding a port.
 *
 * `ingestQueue` is the BullMQ producer used by replay/backfill; when omitted
 * (e.g. unit tests that don't exercise those routes) they respond 503.
 */
export function buildApp({ ingestQueue } = {}) {
  const app = express()
  app.use(express.json())

  // Public liveness probe.
  app.get('/health', (req, res) => res.json({ status: 'ok' }))

  // Everything below requires a tenant API key.
  app.use(tenantAuth)

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
