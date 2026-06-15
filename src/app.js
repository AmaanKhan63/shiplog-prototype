import express from 'express'
import { tenantAuth } from './middleware/tenantAuth.js'
import { withTenant } from './repository/withTenant.js'

/**
 * Build the Express app. Exported as a factory so tests can mount it with
 * supertest without binding a port.
 */
export function buildApp() {
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

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message })
  })

  return app
}
