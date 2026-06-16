/**
 * Inspect the dead-letter queue (Milestone 2 verification).
 *
 *   npm run dlq
 */
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { DeadLetter } from '../src/models/index.js'

async function main() {
  await connectDB(config.mongoUri)

  const docs = await DeadLetter.find({}).sort({ failedAt: -1 }).limit(25).lean()
  const total = await DeadLetter.countDocuments({})

  console.log(`\ndead_letter: ${total} record(s)\n`)
  for (const d of docs) {
    const rec = d.payload?.record as Record<string, any> | undefined
    const model = rec?._nango_metadata?.model ?? 'record'
    // Record identity: sha for commits, #number for issues/PRs, else the Nango id.
    const ident = rec?.sha ?? (rec?.number != null ? `#${rec.number}` : rec?.id) ?? ''
    const poison = d.payload?.poison ? ` poison=${d.payload.poison}` : ''
    console.log(`• ${new Date(d.failedAt!).toISOString()}  attempts=${d.attemptsMade}  ${model}${ident ? ' ' + ident : ''}${poison}`)
    console.log(`    error: ${d.errorMessage}`)
    console.log(`    tenant=${d.tenantId}  syncRun=${d.syncRunId}  dlqId=${d._id}`)
  }
  if (total === 0) console.log('(empty — inject a failure with `npm run inject transient|logical`)')
  console.log('')

  await disconnectDB()
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
