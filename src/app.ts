import express, { type Request, type Response, type NextFunction } from 'express'
import mongoose from 'mongoose'
import { tenantAuth } from './middleware/tenantAuth.js'
import { withTenant } from './repository/withTenant.js'
import { config } from './config/env.js'
import { Connection, DeadLetter, SyncRun } from './models/index.js'
import type { IEvent } from './models/Event.js'
import { replayDeadLetter, backfillConnection } from './queue/replay.js'
import { enqueueReconcileJob } from './queue/reconcileSweep.js'
import { verifyNangoSignature, computeNangoHmac } from './nango/verify.js'
import { NANGO_SYNC_QUEUE } from './queue/queues.js'
import type { Queue } from 'bullmq'
import type { NangoSyncJobData } from './queue/types.js'

export interface BuildAppOptions {
  ingestQueue?: Queue
  nangoSyncQueue?: Queue<NangoSyncJobData>
  reconcileQueue?: Queue
  nangoWebhookSecret?: string
}

/**
 * Build the Express app. Exported as a factory so tests can mount it with
 * supertest without binding a port.
 *
 * `ingestQueue` (replay/backfill) and `nangoSyncQueue` (webhooks) are BullMQ
 * producers; when omitted, the routes that need them respond 503.
 */
export function buildApp({ ingestQueue, nangoSyncQueue, reconcileQueue, nangoWebhookSecret = config.nangoWebhookSecret }: BuildAppOptions = {}) {
  const app = express()

  // Public liveness probe.
  app.get('/health', (req: Request, res: Response) => res.json({ status: 'ok' }))

  // Nango webhook receiver — raw body, signature-authenticated. Registered BEFORE
  // the JSON parser (so the raw bytes survive for HMAC) and before tenantAuth.
  // Responds 2xx fast and enqueues a sync job; the worker fetches records.
  app.post('/webhooks/nango', express.raw({ type: '*/*' }), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawBody = req.body // Buffer (express.raw)
      if (!verifyNangoSignature(rawBody, req.headers, nangoWebhookSecret)) {
        if (config.nangoDebug) {
          console.warn(`[nango] signature mismatch: received=${req.get('x-nango-hmac-sha256')} computed=${computeNangoHmac(rawBody, nangoWebhookSecret)}`)
        }
        return res.status(401).json({ error: 'Invalid signature' })
      }

      let payload: any
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
  app.post('/connections', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { nangoConnectionId, nangoIntegrationId, provider = 'github' } = req.body ?? {}
      if (!nangoConnectionId) return res.status(400).json({ error: 'nangoConnectionId is required' })
      const connection = await Connection.findOneAndUpdate(
        { tenantId: req.tenantId, nangoConnectionId },
        { $set: { nangoIntegrationId, provider, status: 'active' }, $setOnInsert: { tenantId: req.tenantId, nangoConnectionId } },
        { upsert: true, returnDocument: 'after' }
      )
      res.status(201).json({ id: connection!._id, nangoConnectionId, provider })
    } catch (err) {
      next(err)
    }
  })

  // Tenant-scoped consumption API for the normalized event spine.
  app.get('/events', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { type } = req.query
      const filter: mongoose.QueryFilter<IEvent> = {}
      if (type) filter.type = type as IEvent['type']
      const events = await withTenant(req.tenantId!)
        .events.find(filter)
        .sort({ occurredAt: -1 })
        .lean()
      res.json({ count: events.length, events })
    } catch (err) {
      next(err)
    }
  })

  // List the tenant's connections (drives the dashboard Sync Control panel).
  app.get('/connections', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const connections = await Connection.find({ tenantId: req.tenantId }).sort({ createdAt: 1 }).limit(100).lean()
      res.json({ count: connections.length, connections })
    } catch (err) {
      next(err)
    }
  })

  // List the tenant's sync runs, newest first (drives the dashboard Sync Runs table).
  app.get('/sync-runs', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const runs = await SyncRun.find({ tenantId: req.tenantId }).sort({ createdAt: -1 }).limit(50).lean()
      res.json({ count: runs.length, runs })
    } catch (err) {
      next(err)
    }
  })

  // Inspect the tenant's dead-letter queue.
  app.get('/dlq', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await DeadLetter.find({ tenantId: req.tenantId }).sort({ failedAt: -1 }).limit(100).lean()
      res.json({ count: items.length, items })
    } catch (err) {
      next(err)
    }
  })

  // Replay a dead-lettered item — re-enqueue its original payload (same
  // idempotency key, so it can't duplicate).
  app.post('/dlq/:id/replay', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!ingestQueue) return res.status(503).json({ error: 'Queue not configured' })
      const id = req.params.id as string
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' })
      const result = await replayDeadLetter(id, { ingestQueue, tenantId: req.tenantId! })
      if (!result) return res.status(404).json({ error: 'Dead-letter item not found' })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // Trigger reconciliation manually — poll Nango's records API for this
  // connection (one job per model) on the durable cursor. The scheduled sweep
  // does the same on a timer; both land on the deterministic per-model jobId.
  app.post('/connections/:id/reconcile', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!reconcileQueue) return res.status(503).json({ error: 'Queue not configured' })
      const id = req.params.id as string
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid connection id' })
      const requested = req.body?.model
      if (requested !== undefined && typeof requested !== 'string') return res.status(400).json({ error: 'model must be a string' })
      const connection = await Connection.findOne({ _id: id, tenantId: req.tenantId })
      if (!connection) return res.status(404).json({ error: 'Connection not found' })
      const models = requested ? [requested] : (connection.models?.length ? connection.models : ['Commit'])
      for (const model of models) await enqueueReconcileJob(reconcileQueue, connection, model)
      res.status(202).json({ ok: true, connectionId: String(connection._id), models, enqueued: models.length })
    } catch (err) {
      next(err)
    }
  })

  // Backfill a connection by reprocessing its raw_records.
  app.post('/connections/:id/backfill', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!ingestQueue) return res.status(503).json({ error: 'Queue not configured' })
      const id = req.params.id as string
      if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' })
      const result = await backfillConnection(id, { ingestQueue, tenantId: req.tenantId! })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // eslint-disable-next-line no-unused-vars
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    res.status(500).json({ error: (err as Error)?.message })
  })

  return app
}
