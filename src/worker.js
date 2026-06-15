import { config } from './config/env.js'
import { connectDB, disconnectDB } from './db/connect.js'
import { redisConnectionOptions } from './queue/connection.js'
import { createIngestQueue, createDlqQueue, createReconcileQueue } from './queue/queues.js'
import { createIngestWorker } from './queue/ingestWorker.js'
import { createNangoSyncWorker } from './queue/nangoSyncWorker.js'
import { createReconcileWorker, scheduleReconcileSweep } from './queue/reconcileWorker.js'
import { createNangoClient } from './nango/client.js'

/**
 * Worker process (separate from the API). Runs three workers:
 *   - ingest:     normalize + idempotently upsert one record; retry/backoff/DLQ
 *   - nango-sync: fetch changed records from Nango (webhook path), fan out
 *   - reconcile:  poll Nango on a durable cursor (the webhook safety net),
 *                 driven by a repeatable sweep registered here at boot
 */
async function main() {
  await connectDB(config.mongoUri)

  const connection = redisConnectionOptions()
  const dlqQueue = createDlqQueue(connection)
  const ingestQueue = createIngestQueue(connection) // producer for the sync + reconcile workers
  const reconcileQueue = createReconcileQueue(connection) // producer for the sweep's fan-out
  ingestQueue.on('error', (err) => console.error(`[worker] ingest queue error: ${err?.message}`))
  dlqQueue.on('error', (err) => console.error(`[worker] dlq error: ${err?.message}`))
  reconcileQueue.on('error', (err) => console.error(`[worker] reconcile queue error: ${err?.message}`))

  const worker = createIngestWorker({ connection, dlqQueue })
  const nango = createNangoClient()
  const nangoSyncWorker = createNangoSyncWorker({ connection, ingestQueue, nango })
  const reconcileWorker = createReconcileWorker({ connection, nango, ingestQueue, reconcileQueue })

  await Promise.all([worker.waitUntilReady(), nangoSyncWorker.waitUntilReady(), reconcileWorker.waitUntilReady()])

  // Register the repeatable sweep once, here in the worker process (not the API).
  await scheduleReconcileSweep(reconcileQueue)

  console.log(`[worker] ready  Mongo=${config.mongoUri}  Redis=${config.redisUrl}  Nango=${nango.fixtures ? 'fixtures' : 'live'}`)
  console.log(`[worker] processing "ingest" + "nango-sync" + "nango-reconcile" queues; reconcile sweep every ${config.reconcileEveryMs}ms. Ctrl-C to stop.\n`)

  const shutdown = async (sig) => {
    console.log(`\n[worker] ${sig} -> shutting down gracefully...`)
    await Promise.allSettled([worker.close(), nangoSyncWorker.close(), reconcileWorker.close()])
    await Promise.allSettled([ingestQueue.close(), dlqQueue.close(), reconcileQueue.close()])
    await disconnectDB()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[worker] failed to start:', err)
  process.exit(1)
})
