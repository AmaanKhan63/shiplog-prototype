/**
 * Replay a dead-lettered item through the REAL HTTP endpoint, then wait for the
 * worker to finish it and report the before→after event count — so the demo needs
 * no curl and you get immediate proof it landed.
 *
 *   npm run replay [dlqId]
 *
 * With no id it replays the most recent *un-replayed* Acme dead-letter (the one
 * `npm run inject recovery|duplicate` just parked). Requires the API (`npm start`)
 * and the worker (`npm run worker`) running.
 *
 * Note: replay marks the dead-letter row `replayedAt` (audit trail) — it is NOT
 * deleted, so it stays visible in an unfiltered DLQ view. The proof is the event
 * count, not the row vanishing.
 */
import { Job } from 'bullmq'
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { redisConnectionOptions } from '../src/queue/connection.js'
import { createIngestQueue } from '../src/queue/queues.js'
import { Tenant, Event, DeadLetter } from '../src/models/index.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  await connectDB(config.mongoUri)
  const queue = createIngestQueue(redisConnectionOptions())
  queue.on('error', () => {})

  const tenant = await Tenant.findOne({ apiKey: 'acme-api-key' })
  if (!tenant) {
    console.error('Tenant "acme-api-key" not found — run `npm run setup-tenants <nangoConnectionId> github` first.')
    await queue.close(); await disconnectDB(); process.exit(2)
  }
  const tenantId = tenant._id

  let dlqId = process.argv[2]
  if (!dlqId) {
    // Prefer the most recent UN-replayed item; fall back to the most recent overall.
    const pending = await DeadLetter.findOne({ tenantId, replayedAt: { $exists: false } }).sort({ failedAt: -1 }).lean()
    const target = pending ?? (await DeadLetter.findOne({ tenantId }).sort({ failedAt: -1 }).lean())
    if (!target) {
      console.error('No dead-letter items for Acme — inject one first (`npm run inject recovery|duplicate`).')
      await queue.close(); await disconnectDB(); process.exit(2)
    }
    dlqId = String(target._id)
  }

  const before = await Event.countDocuments({ tenantId })

  const url = `http://localhost:${config.port}/dlq/${dlqId}/replay`
  console.log(`Replaying dead-letter ${dlqId} through ${url} ...`)
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${tenant.apiKey}` } })
  const body = (await res.json().catch(() => ({}))) as { jobId?: string }
  if (!res.ok) {
    console.error(`HTTP ${res.status}`, body)
    await queue.close(); await disconnectDB(); process.exit(1)
  }

  // Wait for the worker to finish the re-enqueued job.
  let status = 'unknown'
  let state = 'unknown'
  if (body.jobId) {
    for (let i = 0; i < 50; i++) {
      const job = await Job.fromId(queue, String(body.jobId))
      state = job ? await job.getState() : 'gone'
      if (state === 'completed') { status = String((job!.returnvalue as { status?: string })?.status ?? 'completed'); break }
      if (state === 'failed') { status = `failed (${job!.failedReason})`; break }
      await sleep(200)
    }
  }
  const after = await Event.countDocuments({ tenantId })

  console.log(`\nReplayed job ${body.jobId} → ${status}`)
  if (state !== 'completed' && state !== 'failed') {
    console.log(`⚠ Job is still "${state}" after 10s — is the worker running (\`npm run worker\`)?`)
  }
  console.log(
    after > before
      ? `Acme events: ${before} → ${after}   (+${after - before} — recovered, landed for the first time)`
      : `Acme events: ${before} → ${after}   (unchanged — idempotent no-op; the key already existed)`
  )
  console.log('The dead-letter row stays as an audit record with `replayedAt` set — it is no longer "pending".')

  await queue.close()
  await disconnectDB()
  process.exit(0)
}

main().catch((err) => { console.error('replay failed:', err?.message ?? err); process.exit(1) })
