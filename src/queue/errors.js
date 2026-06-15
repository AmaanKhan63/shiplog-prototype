/**
 * Error taxonomy + classifier for the ingest pipeline.
 *
 * The classifier decides retry policy (AWS guidance: only retry transient
 * errors; never blindly retry a malformed payload):
 *   - transient → 5xx / 429 / network blips → retry with backoff
 *   - logical   → validation / bad payload → straight to the DLQ, no retry
 */

export class TransientError extends Error {
  constructor(message, { statusCode, code, retryAfterMs } = {}) {
    super(message)
    this.name = 'TransientError'
    this.kind = 'transient'
    this.statusCode = statusCode
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export class LogicalError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LogicalError'
    this.kind = 'logical'
  }
}

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED',
])

/** Parse an HTTP `Retry-After` value (delay-seconds or HTTP-date) into ms. */
export function parseRetryAfter(value) {
  if (value == null) return undefined
  if (typeof value === 'number') return value * 1000
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
    const date = Date.parse(trimmed)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  return undefined
}

/** @returns {{ kind: 'transient'|'logical', retryAfterMs: number|undefined }} */
export function classifyError(err) {
  if (!err) return { kind: 'logical', retryAfterMs: undefined }

  // An explicit tag from our own error classes wins.
  if (err.kind === 'transient') return { kind: 'transient', retryAfterMs: err.retryAfterMs }
  if (err.kind === 'logical') return { kind: 'logical', retryAfterMs: undefined }

  // Validation / schema errors are logical — the payload will never get better.
  if (err.name === 'ZodError') return { kind: 'logical', retryAfterMs: undefined }

  // Network-layer blips are transient.
  if (err.code && NETWORK_CODES.has(err.code)) return { kind: 'transient', retryAfterMs: undefined }

  // HTTP status codes.
  const status = err.statusCode ?? err.status
  if (typeof status === 'number') {
    if (status === 429) {
      const retryAfterMs = err.retryAfterMs ?? parseRetryAfter(err.headers?.['retry-after'])
      return { kind: 'transient', retryAfterMs }
    }
    if (status >= 500 && status <= 599) return { kind: 'transient', retryAfterMs: err.retryAfterMs }
    return { kind: 'logical', retryAfterMs: undefined } // other 4xx
  }

  // Unknown → logical: do not blindly retry an error we don't understand.
  return { kind: 'logical', retryAfterMs: undefined }
}
