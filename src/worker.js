import { config } from './config/env.js'
import { connectDB, disconnectDB } from './db/connect.js'
import { redisConnectionOptions } from './queue/connection.js'
import { createDlqQueue } from './queue/queues.js'
import { createIngestWorker } from './queue/ingestWorker.js'

/**
 * The ingest worker — runs as a SEPARATE process from the API (`npm run worker`).
 * Durable, Redis-backed: jobs survive a crash and are retried with backoff; the
 * final failure is dead-lettered with full context.
 */
async function main() {
  await connectDB(config.mongoUri)

  const connection = redisConnectionOptions()
  const dlqQueue = createDlqQueue(connection)
  const worker = createIngestWorker({ connection, dlqQueue })

  // 'error' listeners so a transient Redis blip can't crash the process.
  dlqQueue.on('error', (err) => console.error(`[worker] dlq error: ${err?.message}`))

  await worker.waitUntilReady()
  console.log(`[worker] ready  Mongo=${config.mongoUri}  Redis=${config.redisUrl}`)
  console.log('[worker] processing the "ingest" queue (attempts:5, exponential backoff + jitter). Ctrl-C to stop.\n')

  const shutdown = async (sig) => {
    console.log(`\n[worker] ${sig} → shutting down gracefully...`)
    await worker.close()
    await dlqQueue.close()
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
