/**
 * Remove the synthetic records left by `npm run inject recovery|duplicate`, so the
 * event baseline and the dead_letter queue are clean between takes/retakes.
 *
 *   npm run clean-demo
 *
 * Targets ONLY the clearly-labelled demo records — events whose externalId starts
 * with `commit:demo-`, and dead_letter docs that carry a `demoFault` id. Your real
 * synced commits and their events are never touched (real shas are 40-hex and never
 * start with `demo-`; real records carry no demoFault).
 */
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { Event, DeadLetter } from '../src/models/index.js'

async function main() {
  await connectDB(config.mongoUri)

  const events = await Event.deleteMany({ externalId: { $regex: '^commit:demo-' } })
  const deadLetters = await DeadLetter.deleteMany({ 'payload.demoFault.id': { $exists: true } })

  console.log(`Removed ${events.deletedCount} synthetic demo event(s) and ${deadLetters.deletedCount} demo dead_letter(s).`)
  console.log('Your real synced commits and events were not touched.')

  await disconnectDB()
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
