import { config } from './config/env.js'
import { connectDB, disconnectDB } from './db/connect.js'
import { redisConnectionOptions } from './queue/connection.js'
import { createIngestQueue } from './queue/queues.js'
import { buildApp } from './app.js'

async function main() {
  await connectDB(config.mongoUri)

  // The API is a queue producer: replay/backfill enqueue ingest jobs.
  const ingestQueue = createIngestQueue(redisConnectionOptions())
  ingestQueue.on('error', (err) => console.error(`[api] queue error: ${err?.message}`))

  const app = buildApp({ ingestQueue })
  const server = app.listen(config.port, () => {
    console.log(`shiplog-sync API listening on http://localhost:${config.port}`)
  })

  const shutdown = async (sig) => {
    console.log(`\n[api] ${sig} → shutting down...`)
    server.close()
    await ingestQueue.close()
    await disconnectDB()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
