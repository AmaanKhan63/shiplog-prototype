import { createHash } from 'node:crypto'

/** sha256 hex digest of a string. */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Recursively sort object keys and serialize Dates as ISO strings, so that two
 * semantically-equal values always produce the same JSON regardless of key
 * order or Date-vs-string representation. Used to make contentHash stable.
 */
export function canonicalize(value) {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key])
    }
    return out
  }
  return value
}

/**
 * Deterministic idempotency key: hash(tenantId + source + externalId + version).
 * The same source version always hashes to the same key, so re-running a sync or
 * replaying a record is a no-op against the unique index; a new version (new
 * `version` token) hashes to a distinct key and lands as a new event row.
 */
export function idempotencyKey({ tenantId, source, externalId, version }) {
  return sha256Hex(`${String(tenantId)}|${source}|${externalId}|${String(version)}`)
}

/**
 * Content hash over the *semantic* fields of a normalized event (deliberately
 * excludes the version token). Lets us distinguish a real "updated" (content
 * changed) from a no-op update such as a spurious `updatedAt` bump.
 */
export function contentHash(content) {
  return sha256Hex(JSON.stringify(canonicalize(content)))
}
