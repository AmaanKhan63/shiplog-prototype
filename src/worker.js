import { config } from './config/env.js'
import { connectDB, disconnectDB } from './db/connect.js'
import { redisConnectionOptions } from './queue/connection.js'
import { createIngestQueue, createDlqQueue } from './queue/queues.js'
import { createIngestWorker } from './queue/ingestWorker.js'
import { createNangoSyncWorker } from './queue/nangoSyncWorker.js'
import { createNangoClient } from './nango/client.js'

/**
 * Worker process (separate from the API). Runs two workers:
 *   - ingest:     normalize + idempotently upsert one record; retry/backoff/DLQ
 *   - nango-sync: fetch changed records from Nango, fan out as ingest jobs
 */
async function main() {
  await connectDB(config.mongoUri)

  const connection = redisConnectionOptions()
  const dlqQueue = createDlqQueue(connection)
  const ingestQueue = createIngestQueue(connection) // producer for the nango-sync worker
  ingestQueue.on('error', (err) => console.error(`[worker] ingest queue error: ${err?.message}`))
  dlqQueue.on('error', (err) => console.error(`[worker] dlq error: ${err?.message}`))

  const worker = createIngestWorker({ connection, dlqQueue })
  const nango = createNangoClient()
  const nangoSyncWorker = createNangoSyncWorker({ connection, ingestQueue, nango })

  await Promise.all([worker.waitUntilReady(), nangoSyncWorker.waitUntilReady()])
  console.log(`[worker] ready  Mongo=${config.mongoUri}  Redis=${config.redisUrl}  Nango=${nango.fixtures ? 'fixtures' : 'live'}`)
  console.log('[worker] processing "ingest" + "nango-sync" queues. Ctrl-C to stop.\n')

  const shutdown = async (sig) => {
    console.log(`\n[worker] ${sig} → shutting down gracefully...`)
    await Promise.allSettled([worker.close(), nangoSyncWorker.close()])
    await Promise.allSettled([ingestQueue.close(), dlqQueue.close()])
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
