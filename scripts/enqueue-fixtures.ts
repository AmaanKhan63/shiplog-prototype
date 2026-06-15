/**
 * Move fixture ingestion through the queue (Milestone 2).
 *
 *   npm run enqueue
 *
 * Enqueues the static Nango-shaped GitHub fixtures as `ingest` jobs. The worker
 * (`npm run worker`, separate process) normalizes + idempotently upserts each.
 */
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { redisConnectionOptions } from '../src/queue/connection.js'
import { createIngestQueue } from '../src/queue/queues.js'
import { githubFixtures } from '../src/fixtures/github.js'
import { ensureDemoContext } from './_demo.js'

async function main() {
  await connectDB(config.mongoUri)
  const queue = createIngestQueue(redisConnectionOptions())
  queue.on('error', (err) => console.error(`[queue] error: ${err?.message}`))
  const { tenant, ctx } = await ensureDemoContext('reconcile')

  const jobs = await queue.addBulk(
    githubFixtures.map((record) => ({ name: 'ingest', data: { ...ctx, record } }))
  )

  console.log(`Enqueued ${jobs.length} ingest jobs for tenant "${tenant.name}" (syncRun ${ctx.syncRunId}).`)
  console.log('Watch the worker terminal to see them processed into the event spine.')

  await queue.close()
  await disconnectDB()
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
