import type { Types } from 'mongoose'
import { RawRecord } from '../models/index.js'
import { normalizeGithubRecord } from '../normalize/github.js'
import type { NangoRecord } from '../nango/types.js'

// Best-effort external id for the raw layer; falls back to the Nango record id so
// even an unmappable record can still be landed.
function externalIdOf(record: NangoRecord): string {
  try {
    return normalizeGithubRecord(record).externalId
  } catch {
    return String(record?.id ?? 'unknown')
  }
}

export interface LandRawContext {
  tenantId: Types.ObjectId | string
  connectionId?: Types.ObjectId | string
  source?: string
  via?: 'webhook' | 'reconcile'
}

/**
 * Land a Nango-shaped record into the immutable raw layer (raw_records), the
 * replay/backfill source. Idempotent per {tenantId, connectionId, nangoRecordId}.
 */
export async function landRawRecord(
  record: NangoRecord,
  { tenantId, connectionId, source = 'github', via = 'reconcile' }: LandRawContext
) {
  const nangoRecordId = String(record?.id ?? '')
  return RawRecord.findOneAndUpdate(
    { tenantId, connectionId, nangoRecordId },
    {
      $set: { source, externalId: externalIdOf(record), payload: record, via },
      $setOnInsert: { receivedAt: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  )
}
