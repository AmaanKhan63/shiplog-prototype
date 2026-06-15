/**
 * Milestone 1 verification: prove the idempotency no-op.
 *
 *   npm run verify
 *
 * Ingests the static Nango-shaped GitHub fixtures twice against the real local
 * MongoDB (MONGODB_URI from .env) and prints the run counts. Resets the demo
 * tenant's events + sync_runs first so the first run always shows added:N and
 * the second shows added:0, updated:0 — reproducibly, on every invocation.
 */
import mongoose from 'mongoose'
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { Tenant, Event, SyncRun } from '../src/models/index.js'
import { ingestNangoRecords } from '../src/events/ingest.js'
import type { RunCounts } from '../src/events/ingest.js'
import type { ISyncRun } from '../src/models/SyncRun.js'
import { githubFixtures } from '../src/fixtures/github.js'

const DEMO_TENANT = { name: 'Demo (Acme Storefront)', apiKey: 'demo-api-key' }

function fmt(counts: RunCounts) {
  return `added=${counts.added}  updated=${counts.updated}  deleted=${counts.deleted}  failed=${counts.failed}  unchanged=${counts.unchanged}`
}

async function runOnce(tenantId: mongoose.Types.ObjectId, trigger: ISyncRun['trigger']) {
  const startedAt = new Date()
  const counts = await ingestNangoRecords(githubFixtures, { tenantId })
  await SyncRun.create({
    tenantId,
    trigger,
    status: counts.failed > 0 ? 'failed' : 'success',
    startedAt,
    finishedAt: new Date(),
    counts,
  })
  return counts
}

async function main() {
  console.log(`\nConnecting to ${config.mongoUri}`)
  await connectDB(config.mongoUri)
  await Event.syncIndexes() // ensure the unique idempotencyKey index exists

  const tenant = await Tenant.findOneAndUpdate(
    { apiKey: DEMO_TENANT.apiKey },
    { $setOnInsert: DEMO_TENANT },
    { upsert: true, returnDocument: 'after' }
  )
  const tenantId = tenant._id

  // Reset state so the demo is reproducible every run.
  const delEvents = await Event.deleteMany({ tenantId })
  const delRuns = await SyncRun.deleteMany({ tenantId })
  console.log(`Reset: cleared ${delEvents.deletedCount} events, ${delRuns.deletedCount} sync_runs for tenant "${tenant.name}"`)
  console.log(`Fixtures: ${githubFixtures.length} Nango-shaped GitHub records\n`)

  const run1 = await runOnce(tenantId, 'reconcile')
  console.log(`Run 1 (first ingest):   ${fmt(run1)}`)

  const run2 = await runOnce(tenantId, 'reconcile')
  console.log(`Run 2 (re-ingest):      ${fmt(run2)}`)

  const total = await Event.countDocuments({ tenantId })
  console.log(`\nEvents in store: ${total} (expected ${githubFixtures.length})`)

  const ok =
    run1.added === githubFixtures.length &&
    run2.added === 0 &&
    run2.updated === 0 &&
    total === githubFixtures.length

  console.log(
    ok
      ? '\n✓ Idempotency no-op verified: re-ingesting the same data added 0 and updated 0.\n'
      : '\n✗ Verification FAILED: counts did not match the expected idempotent no-op.\n'
  )

  await disconnectDB()
  process.exit(ok ? 0 : 1)
}

main().catch(async (err) => {
  console.error('\nVerification crashed:', err)
  await disconnectDB().catch(() => {})
  process.exit(1)
})
