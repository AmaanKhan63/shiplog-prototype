/**
 * Trigger the Nango sync for the connected GitHub account FROM THE TERMINAL, so a
 * freshly-pushed commit is fetched into Nango's cache without opening the Nango
 * dashboard mid-demo. The reconcile poller (or a manual POST /reconcile) then
 * pulls the new records in.
 *
 *   npm run trigger-sync [nangoConnectionId] [integrationId]
 *
 * With no args it resolves the connection from the DB (all demo tenants share one
 * real Nango connection). Triggers ALL syncs on the connection (empty syncs list),
 * so you don't need the sync's exact name.
 *
 * Requires a real NANGO_SECRET_KEY in .env (the fixture client can't trigger).
 * Note: triggerSync returns once the sync is QUEUED — wait ~15-30s for Nango to
 * fetch from GitHub before you reconcile.
 */
import { Nango } from '@nangohq/node'
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { Connection } from '../src/models/index.js'

async function main() {
  if (!config.nangoSecretKey || config.nangoUseFixtures) {
    console.error('Set a real NANGO_SECRET_KEY in .env (and do not set NANGO_USE_FIXTURES) to trigger a live Nango sync.')
    process.exit(2)
  }

  await connectDB(config.mongoUri)

  let nangoConnectionId = process.argv[2]
  let integrationId = process.argv[3]
  if (!nangoConnectionId) {
    const conn = await Connection.findOne({ status: 'active', nangoConnectionId: { $ne: null } }).lean()
    if (!conn?.nangoConnectionId) {
      console.error('No active connection found. Run `npm run setup-tenants <nangoConnectionId> github` first, or pass the id explicitly.')
      await disconnectDB()
      process.exit(2)
    }
    nangoConnectionId = conn.nangoConnectionId
    integrationId = integrationId || conn.nangoIntegrationId || 'github'
  }
  integrationId = integrationId || 'github'

  const nango = new Nango({ secretKey: config.nangoSecretKey, host: config.nangoHost })
  console.log(`Triggering Nango sync(s) for connection "${nangoConnectionId}" (integration "${integrationId}")...`)
  await nango.triggerSync(integrationId, [], nangoConnectionId) // empty list = all syncs on the connection

  console.log('Triggered. Wait ~15-30s for Nango to fetch from GitHub, then pull it in:')
  console.log(`  curl -X POST http://localhost:${config.port}/connections/<connectionId>/reconcile -H "Authorization: Bearer acme-api-key"`)

  await disconnectDB()
  process.exit(0)
}

main().catch((err) => { console.error('trigger-sync failed:', err?.message ?? err); process.exit(1) })
