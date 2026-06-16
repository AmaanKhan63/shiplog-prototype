/**
 * Replay a dead-lettered item through the REAL HTTP endpoint, so the demo needs
 * no curl. With no id it replays the most recent dead-letter for the Acme tenant
 * (the one `npm run inject recovery|duplicate` just parked).
 *
 *   npm run replay [dlqId]
 *
 * Requires the API running (`npm start`) and the worker running (`npm run worker`).
 */
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { Tenant, DeadLetter } from '../src/models/index.js'

async function main() {
  await connectDB(config.mongoUri)

  const tenant = await Tenant.findOne({ apiKey: 'acme-api-key' })
  if (!tenant) {
    console.error('Tenant "acme-api-key" not found — run `npm run setup-tenants <nangoConnectionId> github` first.')
    await disconnectDB()
    process.exit(2)
  }

  let dlqId = process.argv[2]
  if (!dlqId) {
    const latest = await DeadLetter.findOne({ tenantId: tenant._id }).sort({ failedAt: -1 }).lean()
    if (!latest) {
      console.error('No dead-letter items for Acme — inject one first (`npm run inject recovery|duplicate`).')
      await disconnectDB()
      process.exit(2)
    }
    dlqId = String(latest._id)
  }

  const url = `http://localhost:${config.port}/dlq/${dlqId}/replay`
  console.log(`Replaying dead-letter ${dlqId} through ${url} ...`)
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${tenant.apiKey}` } })
  const body = await res.json().catch(() => ({}))
  console.log(`HTTP ${res.status}`, body)

  await disconnectDB()
  process.exit(res.ok ? 0 : 1)
}

main().catch((err) => { console.error('replay failed:', err?.message ?? err); process.exit(1) })
