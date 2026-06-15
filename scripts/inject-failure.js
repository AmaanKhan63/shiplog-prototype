/**
 * Inject a failure on demand (Milestone 2 demo).
 *
 *   npm run inject transient   # 5xx-style error → retries with backoff → DLQ
 *   npm run inject logical     # bad-payload error → straight to DLQ, no retry
 *
 * Enqueues a single poisoned ingest job. Watch the worker terminal to see the
 * retry/backoff (transient) or the immediate dead-letter (logical), then run
 * `npm run dlq` to inspect the dead_letter record.
 */
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { redisConnectionOptions } from '../src/queue/connection.js'
import { createIngestQueue } from '../src/queue/queues.js'
import { githubFixtures } from '../src/fixtures/github.js'
import { ensureDemoContext } from './_demo.js'

const mode = (process.argv[2] || '').toLowerCase()
if (mode !== 'transient' && mode !== 'logical') {
  console.error('Usage: npm run inject <transient|logical>')
  process.exit(2)
}

async function main() {
  await connectDB(config.mongoUri)
  const queue = createIngestQueue(redisConnectionOptions())
  queue.on('error', (err) => console.error(`[queue] error: ${err?.message}`))
  const { ctx } = await ensureDemoContext('reconcile')

  // Reuse a real fixture so the payload is realistic; the poison flag forces the
  // chosen failure path inside the processor.
  const record = { ...githubFixtures[0] }
  const job = await queue.add('ingest', { ...ctx, record, poison: mode })

  console.log(`Injected a ${mode} failure as job ${job.id}.`)
  console.log(
    mode === 'transient'
      ? 'Expect: 5 attempts with exponential backoff (~1s, 2s, 4s, 8s) in the worker log, then one dead_letter doc (attemptsMade=5).'
      : 'Expect: 1 attempt, no retry, immediate dead_letter doc (attemptsMade=1).'
  )

  await queue.close()
  await disconnectDB()
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
