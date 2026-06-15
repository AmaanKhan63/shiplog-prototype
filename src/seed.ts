import 'dotenv/config'
import mongoose from 'mongoose'
import { randomBytes } from 'node:crypto'
import { Tenant, Connection, SyncState } from './models/index.js'

const MONGODB_URI = process.env.MONGODB_URI!
const CONNECTION_ID = process.env.CONNECTION_ID!
const INTEGRATION_ID = process.env.NANGO_INTEGRATION_ID!

async function main() {
  await mongoose.connect(MONGODB_URI)

  let tenant = await Tenant.findOne({ name: 'Acme' })
  if (!tenant) {
    tenant = await Tenant.create({ name: 'Acme', apiKey: randomBytes(24).toString('hex') })
  }

  // Clean slate: drop any stale connections + cursors, then create one good one.
  await Connection.deleteMany({})
  await SyncState.deleteMany({})

  const connection = await Connection.create({
    tenantId: tenant._id,
    provider: 'github',
    nangoConnectionId: CONNECTION_ID,
    nangoIntegrationId: INTEGRATION_ID,
    status: 'active',
    models: ['Issue'], // <-- Nango's real model name, from the Syncs tab
  })

  console.log('\nSeed complete:')
  console.log('  TENANT_ID  =', tenant._id.toString())
  console.log('  API_KEY    =', tenant.apiKey)
  console.log('  CONNECTION =', connection._id.toString())
  console.log('  MODELS     =', connection.models.join(', '))
  console.log()

  await mongoose.disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })