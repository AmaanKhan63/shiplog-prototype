/**
 * Store a Nango connection id on the demo tenant's connection (Milestone 4 setup).
 *
 *   npm run connect <nangoConnectionId> [integrationId]
 *
 * The nangoConnectionId MUST exactly match the connection id you assign in Nango;
 * it's how incoming webhooks resolve to this tenant.
 */
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { Tenant, Connection } from '../src/models/index.js'

const DEMO = { name: 'Demo (Acme Storefront)', apiKey: 'demo-api-key' }
const nangoConnectionId = process.argv[2]
const integrationId = process.argv[3] || 'github'

if (!nangoConnectionId) {
  console.error('Usage: npm run connect <nangoConnectionId> [integrationId]')
  process.exit(2)
}

async function main() {
  await connectDB(config.mongoUri)
  const tenant = await Tenant.findOneAndUpdate({ apiKey: DEMO.apiKey }, { $setOnInsert: DEMO }, { upsert: true, returnDocument: 'after' })
  const connection = await Connection.findOneAndUpdate(
    { tenantId: tenant._id, nangoConnectionId },
    { $set: { provider: 'github', nangoIntegrationId: integrationId, status: 'active' }, $setOnInsert: { tenantId: tenant._id, nangoConnectionId } },
    { upsert: true, returnDocument: 'after' }
  )

  console.log(`Connection stored for tenant "${tenant.name}" (apiKey=${DEMO.apiKey}):`)
  console.log(`  nangoConnectionId  = ${nangoConnectionId}`)
  console.log(`  nangoIntegrationId = ${integrationId}`)
  console.log(`  connectionId       = ${connection._id}`)
  console.log('\nNango webhooks carrying this connectionId will now resolve to this tenant.')

  await disconnectDB()
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
