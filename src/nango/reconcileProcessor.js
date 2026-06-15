import { landRawRecord } from '../events/raw.js'
import { SyncState } from '../models/index.js'
import { INGEST_QUEUE } from '../queue/queues.js'

/**
 * Build a processor for the reconcile queue — the webhook safety net.
 *
 * Unlike the webhook path (which reacts to a notification), reconciliation
 * *polls* Nango's records API on a durable cursor stored in sync_state, so it
 * recovers anything a webhook dropped. It paginates a connection+model, lands
 * each record into raw_records (the durable replay source) and fans it out as an
 * ingest job — then advances the cursor.
 *
 * The cursor advances ONLY after a page's records are durably landed
 * (checkpoint-after-write), per page. If the fetch or a landing throws, the
 * cursor is left where the last fully-landed page put it, so the BullMQ retry
 * resumes from there — never re-pulling the whole history, never skipping a
 * record. "Cursor advances on success, stays put on failure."
 *
 * Note the layering: a cursor that advanced means records are durably in
 * raw_records + an ingest job is enqueued — NOT that they're confirmed in the
 * events spine. A record whose ingest later dead-letters is recovered via M3
 * replay/backfill; reconcile is the *delivery* safety net, the ingest
 * retry/DLQ is the *processing* one.
 */
export function makeReconcileProcessor({ nango, ingestQueue }) {
  return async function reconcileProcessor(job) {
    const { tenantId, connectionId, nangoConnectionId, providerConfigKey, model } = job.data

    // Resume from the durable cursor (undefined on the first ever run → Nango
    // returns from the beginning).
    const state = await SyncState.findOne({ tenantId, connectionId, model }).lean()
    let cursor = state?.cursor

    let fetched = 0
    let enqueued = 0
    let pageCursor = cursor

    for (;;) {
      const page = await nango.listRecords({ providerConfigKey, connectionId: nangoConnectionId, model, cursor: pageCursor })
      const records = page?.records ?? []
      // An empty page means there's nothing more right now — stop, even if the
      // API echoed a next_cursor (guards against a non-advancing-token loop).
      if (records.length === 0) break

      for (const record of records) {
        fetched += 1
        const meta = record._nango_metadata ?? {}
        if (meta.deleted_at || meta.last_action === 'DELETED') continue

        // Stamp the model so the connector-agnostic normalizer can map it.
        const stamped = { ...record, _nango_metadata: { ...meta, model } }
        await landRawRecord(stamped, { tenantId, connectionId, via: 'reconcile' })
        await ingestQueue.add(INGEST_QUEUE, { tenantId, connectionId, record: stamped })
        enqueued += 1
      }

      // Checkpoint AFTER the page is durably landed: persist the last record's
      // cursor (Nango's documented incremental resume point), falling back to
      // the page's next_cursor if a record carries none.
      cursor = records[records.length - 1]._nango_metadata?.cursor ?? page?.next_cursor ?? cursor
      await SyncState.updateOne(
        { tenantId, connectionId, model },
        { $set: { cursor, lastSyncAt: new Date(), mode: 'incremental' } },
        { upsert: true }
      )

      // Stop when the API has no more pages, or hands back a non-advancing token.
      const next = page?.next_cursor
      if (!next || next === pageCursor) break
      pageCursor = next
    }

    return { fetched, enqueued, cursor }
  }
}
