import { DeadLetter, RawRecord } from '../models/index.js'
import { INGEST_QUEUE } from './queues.js'

/**
 * Replay a dead-lettered item: re-enqueue its original payload **verbatim** onto
 * the ingest queue and stamp `replayedAt`. The payload is unchanged, so the
 * worker recomputes the *same* idempotency key — replaying can never duplicate
 * (the M1 unique index / `Event.exists` short-circuit makes it a no-op).
 *
 * Tenant-scoped: returns null if the item doesn't belong to the tenant.
 */
export async function replayDeadLetter(deadLetterId, { ingestQueue, tenantId }) {
  const item = await DeadLetter.findOne({ _id: deadLetterId, tenantId })
  if (!item) return null

  const job = await ingestQueue.add(INGEST_QUEUE, item.payload)
  item.replayedAt = new Date()
  await item.save()

  return { replayed: true, deadLetterId: String(item._id), jobId: job?.id, payload: item.payload }
}

/**
 * Backfill a connection by reprocessing its raw_records — re-enqueue one ingest
 * job per stored raw record. Idempotent downstream, so re-running never
 * duplicates. (Nango records-API wiring arrives in Milestone 5; this reprocesses
 * what's already landed.)
 */
export async function backfillConnection(connectionId, { ingestQueue, tenantId }) {
  const raws = await RawRecord.find({ tenantId, connectionId }).lean()

  for (const raw of raws) {
    await ingestQueue.add(INGEST_QUEUE, {
      tenantId: String(tenantId),
      connectionId: String(connectionId),
      record: raw.payload,
    })
  }

  return { enqueued: raws.length }
}
