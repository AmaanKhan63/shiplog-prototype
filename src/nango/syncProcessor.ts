import type { Queue } from 'bullmq'
import { landRawRecord } from '../events/raw.js'
import { INGEST_QUEUE } from '../queue/queues.js'
import type { NangoClientLike } from './types.js'
import type { IngestJobData, JobView, NangoSyncJobData } from '../queue/types.js'

export interface NangoSyncResult {
  fetched: number
  enqueued: number
}

/**
 * Build a processor for the nango-sync queue.
 *
 * A sync webhook only *notifies* us that records changed, so the worker fetches
 * the changed records via Nango's records API (paginated by cursor), lands each
 * into raw_records, and enqueues one ingest job per record onto the ingest queue.
 * The existing ingest worker then normalizes + idempotently upserts them — so a
 * duplicated webhook is harmless (same idempotency keys, no duplicate events).
 *
 * Deleted records (tombstones) are skipped; they aren't live events.
 */
export function makeNangoSyncProcessor({ nango, ingestQueue }: { nango: NangoClientLike; ingestQueue: Queue<IngestJobData> }) {
  return async function nangoSyncProcessor(job: JobView<NangoSyncJobData>): Promise<NangoSyncResult> {
    const { tenantId, connectionId, nangoConnectionId, providerConfigKey, model, modifiedAfter } = job.data

    let cursor: string | null | undefined
    let fetched = 0
    let enqueued = 0

    do {
      const page = await nango.listRecords({
        providerConfigKey,
        connectionId: nangoConnectionId,
        model,
        modifiedAfter,
        cursor,
      })
      const records = page?.records ?? []

      for (const record of records) {
        fetched += 1
        const meta = record._nango_metadata ?? {}
        if (meta.deleted_at || meta.last_action === 'DELETED') continue

        // Stamp the model so the connector-agnostic normalizer can map it.
        const stamped = { ...record, _nango_metadata: { ...meta, model } }
        await landRawRecord(stamped, { tenantId, connectionId })
        await ingestQueue.add(INGEST_QUEUE, { tenantId, connectionId, record: stamped })
        enqueued += 1
      }

      cursor = page?.next_cursor
    } while (cursor)

    return { fetched, enqueued }
  }
}
