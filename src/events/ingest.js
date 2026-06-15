import { Event } from '../models/index.js'
import { NormalizedEventSchema } from './schema.js'
import { normalizeGithubRecord } from '../normalize/github.js'
import { idempotencyKey, contentHash } from './hash.js'

/**
 * Idempotently ingest one normalized event into the tenant-scoped spine.
 *
 * Returns `{ status, idempotencyKey }` where status is one of:
 *   - 'added'     first time we've seen this entity
 *   - 'updated'   a new version with genuinely changed content (append-per-version)
 *   - 'unchanged' a no-op: exact-version replay, or a version bump whose semantic
 *                 content is identical (content-hash dedup)
 *
 * Correctness notes:
 *   - The unique index on idempotencyKey makes re-processing the same source
 *     version a guaranteed no-op, even under concurrent workers (E11000 → no-op).
 *   - Because each version is its own row, replaying a stale version can never
 *     overwrite the current state — it just lands (or no-ops) as history. This is
 *     what makes the Milestone 3 failure→replay→no-duplicate demo safe.
 */
export async function ingestEvent(input, { tenantId } = {}) {
  if (!tenantId) throw new Error('ingestEvent requires a tenantId')

  const ev = NormalizedEventSchema.parse(input)

  const idemKey = idempotencyKey({
    tenantId,
    source: ev.source,
    externalId: ev.externalId,
    version: ev.version,
  })
  const cHash = contentHash({
    source: ev.source,
    type: ev.type,
    externalId: ev.externalId,
    actor: ev.actor,
    title: ev.title,
    url: ev.url,
    occurredAt: ev.occurredAt,
  })

  // 1) Exact-version replay → no-op (fast path; the unique index is the backstop).
  if (await Event.exists({ tenantId, idempotencyKey: idemKey })) {
    return { status: 'unchanged', idempotencyKey: idemKey }
  }

  // 2) Classify against the latest known version of this entity.
  const latest = await Event.findOne({ tenantId, source: ev.source, externalId: ev.externalId })
    .sort({ occurredAt: -1, _id: -1 })
    .select('contentHash')
    .lean()

  let status
  if (!latest) {
    status = 'added'
  } else if (latest.contentHash === cHash) {
    // New version token, identical semantic content → suppress the no-op update.
    return { status: 'unchanged', idempotencyKey: idemKey }
  } else {
    status = 'updated'
  }

  // 3) Idempotent append.
  let res
  try {
    res = await Event.updateOne(
      { idempotencyKey: idemKey },
      {
        $setOnInsert: {
          tenantId,
          source: ev.source,
          type: ev.type,
          externalId: ev.externalId,
          idempotencyKey: idemKey,
          contentHash: cHash,
          actor: ev.actor,
          title: ev.title,
          url: ev.url,
          occurredAt: ev.occurredAt,
          version: ev.version,
          deleted: false,
        },
      },
      { upsert: true }
    )
  } catch (err) {
    // Lost a race to a concurrent insert of the same version → still a no-op.
    if (err?.code === 11000) return { status: 'unchanged', idempotencyKey: idemKey }
    throw err
  }

  if (res.upsertedCount === 0) return { status: 'unchanged', idempotencyKey: idemKey }
  return { status, idempotencyKey: idemKey }
}

const emptyCounts = () => ({ added: 0, updated: 0, deleted: 0, failed: 0, unchanged: 0 })

/**
 * Normalize + ingest a batch of Nango records, returning the run counts.
 * A record that can't be normalized or validated is counted as `failed`
 * (it does not abort the batch) — the realistic at-least-once posture.
 */
export async function ingestNangoRecords(records, ctx, normalize = normalizeGithubRecord) {
  const counts = emptyCounts()
  for (const record of records) {
    try {
      const normalized = normalize(record)
      const { status } = await ingestEvent(normalized, ctx)
      counts[status] += 1
    } catch {
      counts.failed += 1
    }
  }
  return counts
}
