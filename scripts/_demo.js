import { Tenant, Connection, SyncRun } from '../src/models/index.js'

export const DEMO_TENANT = { name: 'Demo (Acme Storefront)', apiKey: 'demo-api-key' }

/**
 * Ensure the demo tenant + GitHub connection exist and open a sync_run, so jobs
 * carry { tenantId, connectionId, syncRunId } — the full context the DLQ records.
 * IDs are returned as strings because BullMQ serializes job data to JSON.
 */
export async function ensureDemoContext(trigger = 'reconcile') {
  const tenant = await Tenant.findOneAndUpdate(
    { apiKey: DEMO_TENANT.apiKey },
    { $setOnInsert: DEMO_TENANT },
    { upsert: true, returnDocument: 'after' }
  )
  const connection = await Connection.findOneAndUpdate(
    { tenantId: tenant._id, provider: 'github' },
    { $setOnInsert: { tenantId: tenant._id, provider: 'github', nangoConnectionId: 'demo-conn', nangoIntegrationId: 'github', status: 'active' } },
    { upsert: true, returnDocument: 'after' }
  )
  const syncRun = await SyncRun.create({ tenantId: tenant._id, connectionId: connection._id, trigger, status: 'running' })

  return {
    tenant,
    connection,
    syncRun,
    ctx: {
      tenantId: tenant._id.toString(),
      connectionId: connection._id.toString(),
      syncRunId: syncRun._id.toString(),
    },
  }
}
