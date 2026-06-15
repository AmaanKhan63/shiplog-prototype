import type { Queue } from 'bullmq'
import type { Types } from 'mongoose'
import { DeadLetter, RawRecord } from '../models/index.js'
import { INGEST_QUEUE } from './queues.js'
import type { IngestJobData } from './types.js'

export interface ReplayOptions {
  ingestQueue: Queue
  tenantId: Types.ObjectId | string
}

/**
 * Replay a dead-lettered item: re-enqueue its original payload **verbatim** onto
 * the ingest queue and stamp `replayedAt`. The payload is unchanged, so the
 * worker recomputes the *same* idempotency key — replaying can never duplicate
 * (the M1 unique index / `Event.exists` short-circuit makes it a no-op).
 *
 * Tenant-scoped: returns null if the item doesn't belong to the tenant.
 */
export async function replayDeadLetter(deadLetterId: string, { ingestQueue, tenantId }: ReplayOptions) {
  const item = await DeadLetter.findOne({ _id: deadLetterId, tenantId })
  if (!item) return null

  const job = await ingestQueue.add(INGEST_QUEUE, item.payload as IngestJobData)
  item.replayedAt = new Date()
  await item.save()

  return { replayed: true, deadLetterId: String(item._id), jobId: job?.id, payload: item.payload }
}

export interface BackfillOptions {
  ingestQueue: Queue
  tenantId: Types.ObjectId | string
}

/**
 * Backfill a connection by reprocessing its raw_records — re-enqueue one ingest
 * job per stored raw record. Idempotent downstream, so re-running never
 * duplicates. (Nango records-API wiring arrives in Milestone 5; this reprocesses
 * what's already landed.)
 */
export async function backfillConnection(connectionId: string | Types.ObjectId, { ingestQueue, tenantId }: BackfillOptions) {
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
