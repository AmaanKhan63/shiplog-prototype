/**
 * Multi-tenant isolation demo setup (two real tenants, one real Nango connection).
 *
 *   npm run setup-tenants [nangoConnectionId] [integrationId]
 *
 * Creates TWO tenants — "Acme" and "Globex" — each with its own API key, BOTH
 * mapped to the SAME real Nango GitHub connection. A reconcile (manual trigger,
 * or the periodic sweep) then polls that one Nango connection once per tenant
 * connection and lands the *same real records* stamped with each tenant's
 * tenantId. Nothing is fabricated: both tenants' events come from the same real
 * sync through Nango, just partitioned per-tenant.
 *
 * Note: the webhook receiver resolves a connection by nangoConnectionId with
 * findOne, so it fans a sync notification to only ONE of the two tenants. For a
 * clean, deterministic per-tenant demo, trigger reconcile per connection (the
 * commands printed below) rather than relying on the webhook to feed both.
 */
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { Tenant, Connection } from '../src/models/index.js'

const NANGO_CONNECTION_ID = process.argv[2];
const INTEGRATION_ID = process.argv[3];

const TENANTS = [
  { name: 'Acme', apiKey: 'acme-api-key' },
  // { name: 'Globex', apiKey: 'globex-api-key' },
]

async function upsertTenantConnection(name: string, apiKey: string) {
  const tenant = await Tenant.findOneAndUpdate(
    { apiKey },
    { $setOnInsert: { name, apiKey } },
    { upsert: true, returnDocument: 'after' }
  )
  const connection = await Connection.findOneAndUpdate(
    { tenantId: tenant!._id, nangoConnectionId: NANGO_CONNECTION_ID },
    {
      $set: { provider: 'github', nangoIntegrationId: INTEGRATION_ID, status: 'active', models: ['Commit'] },
      $setOnInsert: { tenantId: tenant!._id, nangoConnectionId: NANGO_CONNECTION_ID },
    },
    { upsert: true, returnDocument: 'after' }
  )
  return { tenant: tenant!, connection: connection! }
}

async function main() {
  await connectDB(config.mongoUri)

  const rows = []
  for (const t of TENANTS) rows.push(await upsertTenantConnection(t.name, t.apiKey))

  console.log(`\nTwo tenants mapped to the SAME Nango connection ${NANGO_CONNECTION_ID}:\n`)
  for (const { tenant, connection } of rows) {
    console.log(`  ${tenant.name}`)
    console.log(`    apiKey       = ${tenant.apiKey}`)
    console.log(`    tenantId     = ${tenant._id}`)
    console.log(`    connectionId = ${connection._id}   (Mongo _id — use this in the reconcile URL)`)
    console.log('')
  }

  const [acme, globex] = rows
  console.log('Demo (API on :3000 + worker running, with a real NANGO_SECRET_KEY in .env):')
  console.log('  # 1) pull the real sync once per tenant — each stamps its own tenantId:')
  console.log(`  curl -X POST localhost:3000/connections/${acme.connection._id}/reconcile -H "Authorization: Bearer ${acme.tenant.apiKey}"`)
  console.log(`  curl -X POST localhost:3000/connections/${globex.connection._id}/reconcile -H "Authorization: Bearer ${globex.tenant.apiKey}"`)
  console.log('  # 2) query each tenant by its key — same commits, different tenantId, never crossed:')
  console.log(`  curl localhost:3000/events -H "Authorization: Bearer ${acme.tenant.apiKey}"`)
  console.log(`  curl localhost:3000/events -H "Authorization: Bearer ${globex.tenant.apiKey}"`)
  console.log('')

  await disconnectDB()
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
