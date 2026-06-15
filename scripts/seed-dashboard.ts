/**
 * Milestone 6: seed the dashboard with two isolated tenants so the tenant
 * switcher visibly proves isolation.
 *
 *   npm run seed
 *
 * Idempotent: upserts the tenants + connections and resets their events,
 * raw_records, sync_runs and dead_letter on every run.
 *
 *   Tenant 1  "Demo (Acme Storefront)"  apiKey demo-api-key    (the existing demo tenant)
 *   Tenant 2  "Globex Industries"       apiKey demo-api-key-2
 *
 * The two tenants get deliberately *different* data (5 vs 3 events, a DLQ item
 * only on Acme, distinct connections) so switching tenants in the dashboard
 * shows the isolation at a glance.
 *
 * NOTE: `npm run verify` resets tenant 1's events + sync_runs (it shares
 * demo-api-key). Re-run `npm run seed` to repopulate the dashboard afterward.
 */
import mongoose from 'mongoose'
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { Tenant, Connection, Event, RawRecord, SyncRun, DeadLetter } from '../src/models/index.js'
import { ingestEvent } from '../src/events/ingest.js'
import { landRawRecord } from '../src/events/raw.js'
import { normalizeGithubRecord } from '../src/normalize/github.js'
import { githubFixtures } from '../src/fixtures/github.js'
import type { NangoRecord } from '../src/nango/types.js'

// Globex's own GitHub-shaped records, so its rows read distinctly from Acme's.
const globexRecords: NangoRecord[] = [
  { id: 'gh_issue_900', _nango_metadata: { model: 'GithubIssue', cursor: 'g-900', deleted_at: null }, number: 900, title: 'Invoices export in the wrong currency', state: 'open', html_url: 'https://github.com/globex/billing/issues/900', user: { login: 'lena' }, created_at: '2024-04-01T09:00:00Z', updated_at: '2024-04-02T09:00:00Z' },
  { id: 'gh_issue_901', _nango_metadata: { model: 'GithubIssue', cursor: 'g-901', deleted_at: null }, number: 901, title: 'Rate limit hit on bulk import', state: 'closed', html_url: 'https://github.com/globex/billing/issues/901', user: { login: 'omar' }, created_at: '2024-04-03T11:00:00Z', updated_at: '2024-04-05T11:00:00Z' },
  { id: 'gh_pr_55', _nango_metadata: { model: 'GithubPullRequest', cursor: 'g-pr55', deleted_at: null }, number: 55, title: 'Add multi-currency invoice support', state: 'open', html_url: 'https://github.com/globex/billing/pull/55', user: { login: 'lena' }, created_at: '2024-04-04T10:00:00Z', updated_at: '2024-04-06T10:00:00Z' },
]

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000)

async function resetTenant(tenantId: mongoose.Types.ObjectId) {
  await Promise.all([
    Event.deleteMany({ tenantId }),
    RawRecord.deleteMany({ tenantId }),
    SyncRun.deleteMany({ tenantId }),
    DeadLetter.deleteMany({ tenantId }),
  ])
}

async function upsertTenant(name: string, apiKey: string) {
  return Tenant.findOneAndUpdate({ apiKey }, { $setOnInsert: { name, apiKey } }, { upsert: true, returnDocument: 'after' })
}

async function upsertConnection(tenantId: mongoose.Types.ObjectId, nangoConnectionId: string) {
  return Connection.findOneAndUpdate(
    { tenantId, nangoConnectionId },
    { $set: { provider: 'github', nangoIntegrationId: 'github', status: 'active', models: ['GithubIssue', 'GithubPullRequest'] }, $setOnInsert: { tenantId, nangoConnectionId } },
    { upsert: true, returnDocument: 'after' }
  )
}

/** Land raw_records + ingest events for a batch under one connection. */
async function ingestBatch(records: NangoRecord[], tenantId: mongoose.Types.ObjectId, connectionId: mongoose.Types.ObjectId) {
  let added = 0
  for (const record of records) {
    await landRawRecord(record, { tenantId, connectionId })
    const { status } = await ingestEvent(normalizeGithubRecord(record), { tenantId })
    if (status === 'added') added++
  }
  return added
}

async function main() {
  console.log(`\nConnecting to ${config.mongoUri}`)
  await connectDB(config.mongoUri)
  await Promise.all([Event.syncIndexes(), Connection.syncIndexes()])

  // ---- Tenant 1: Acme (the existing demo tenant) ----
  const acme = await upsertTenant('Demo (Acme Storefront)', 'demo-api-key')
  await resetTenant(acme._id)
  const acmeConn = await upsertConnection(acme._id, 'nc-acme')

  // Ingest 5 of the 6 fixtures; hold gh_commit_b out in the DLQ so a Replay
  // (worker up) adds the 6th event — a live, visible replay→no-duplicate proof.
  const acmeAdded = await ingestBatch(githubFixtures.slice(0, 5), acme._id, acmeConn._id)
  await SyncRun.create([
    { tenantId: acme._id, connectionId: acmeConn._id, trigger: 'reconcile', status: 'success', counts: { added: acmeAdded, updated: 0, deleted: 0, failed: 0 }, startedAt: minsAgo(42), finishedAt: minsAgo(42) },
    { tenantId: acme._id, connectionId: acmeConn._id, trigger: 'webhook', status: 'success', counts: { added: 0, updated: 0, deleted: 0, failed: 0 }, startedAt: minsAgo(18), finishedAt: minsAgo(18) },
    { tenantId: acme._id, connectionId: acmeConn._id, trigger: 'reconcile', status: 'failed', counts: { added: 0, updated: 0, deleted: 0, failed: 1 }, startedAt: minsAgo(6), finishedAt: minsAgo(6) },
    // A still-running row exercises the "no finishedAt → duration —" display path.
    { tenantId: acme._id, connectionId: acmeConn._id, trigger: 'reconcile', status: 'running', counts: { added: 0, updated: 0, deleted: 0, failed: 0 }, startedAt: minsAgo(1) },
  ])
  // The held-out 6th record was landed in raw_records (as in the real pipeline —
  // raw lands before ingest) but its ingest "failed" → it sits in the DLQ, not yet
  // in events. So the raw layer mirrors what actually arrived, and both Replay and
  // Backfill can recover it.
  await landRawRecord(githubFixtures[5], { tenantId: acme._id, connectionId: acmeConn._id })
  await DeadLetter.create({
    tenantId: acme._id,
    connectionId: acmeConn._id,
    payload: { tenantId: String(acme._id), connectionId: String(acmeConn._id), record: githubFixtures[5] },
    errorMessage: 'transient: downstream sink returned 503 (Service Unavailable)',
    attemptsMade: 5,
    failedAt: minsAgo(6),
  })

  // ---- Tenant 2: Globex ----
  const globex = await upsertTenant('Globex Industries', 'demo-api-key-2')
  await resetTenant(globex._id)
  const globexConn = await upsertConnection(globex._id, 'nc-globex')
  const globexAdded = await ingestBatch(globexRecords, globex._id, globexConn._id)
  await SyncRun.create([
    { tenantId: globex._id, connectionId: globexConn._id, trigger: 'reconcile', status: 'success', counts: { added: globexAdded, updated: 0, deleted: 0, failed: 0 }, startedAt: minsAgo(30), finishedAt: minsAgo(30) },
    { tenantId: globex._id, connectionId: globexConn._id, trigger: 'backfill', status: 'success', counts: { added: 0, updated: 0, deleted: 0, failed: 0 }, startedAt: minsAgo(12), finishedAt: minsAgo(12) },
  ])

  const summary = async (tenantId: mongoose.Types.ObjectId) => ({
    events: await Event.countDocuments({ tenantId }),
    runs: await SyncRun.countDocuments({ tenantId }),
    dlq: await DeadLetter.countDocuments({ tenantId }),
    connections: await Connection.countDocuments({ tenantId }),
  })

  console.log('\nSeeded two isolated tenants:')
  console.log(`  demo-api-key    Acme Storefront   ${JSON.stringify(await summary(acme._id))}`)
  console.log(`  demo-api-key-2  Globex Industries ${JSON.stringify(await summary(globex._id))}`)
  console.log('\n✓ Dashboard data ready. Start: npm start | npm run worker | (cd dashboard && npm run dev)\n')

  await disconnectDB()
  process.exit(0)
}

main().catch(async (err) => {
  console.error('\nSeed crashed:', err)
  await disconnectDB().catch(() => {})
  process.exit(1)
})
