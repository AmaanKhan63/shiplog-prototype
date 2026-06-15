/**
 * Error taxonomy + classifier for the ingest pipeline.
 *
 * The classifier decides retry policy (AWS guidance: only retry transient
 * errors; never blindly retry a malformed payload):
 *   - transient → 5xx / 429 / network blips → retry with backoff
 *   - logical   → validation / bad payload → straight to the DLQ, no retry
 */

export type ErrorKind = 'transient' | 'logical'

export interface ClassifiedError {
  kind: ErrorKind
  retryAfterMs: number | undefined
}

// The duck-typed shape classifyError inspects (our own error classes, plus
// HTTP/network errors from SDKs).
interface ClassifiableError {
  name?: string
  message?: string
  kind?: ErrorKind
  code?: string
  statusCode?: number
  status?: number
  retryAfterMs?: number
  headers?: Record<string, string | undefined>
}

export interface TransientErrorOptions {
  statusCode?: number
  code?: string
  retryAfterMs?: number
}

export class TransientError extends Error {
  readonly kind = 'transient'
  statusCode?: number
  code?: string
  retryAfterMs?: number
  constructor(message?: string, { statusCode, code, retryAfterMs }: TransientErrorOptions = {}) {
    super(message)
    this.name = 'TransientError'
    this.statusCode = statusCode
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export class LogicalError extends Error {
  readonly kind = 'logical'
  constructor(message?: string) {
    super(message)
    this.name = 'LogicalError'
  }
}

const NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED',
])

/** Parse an HTTP `Retry-After` value (delay-seconds or HTTP-date) into ms. */
export function parseRetryAfter(value: unknown): number | undefined {
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

export function classifyError(err: unknown): ClassifiedError {
  if (!err) return { kind: 'logical', retryAfterMs: undefined }
  const e = err as ClassifiableError

  // An explicit tag from our own error classes wins.
  if (e.kind === 'transient') return { kind: 'transient', retryAfterMs: e.retryAfterMs }
  if (e.kind === 'logical') return { kind: 'logical', retryAfterMs: undefined }

  // Validation / schema errors are logical — the payload will never get better.
  if (e.name === 'ZodError') return { kind: 'logical', retryAfterMs: undefined }

  // Network-layer blips are transient.
  if (e.code && NETWORK_CODES.has(e.code)) return { kind: 'transient', retryAfterMs: undefined }

  // HTTP status codes.
  const status = e.statusCode ?? e.status
  if (typeof status === 'number') {
    if (status === 429) {
      const retryAfterMs = e.retryAfterMs ?? parseRetryAfter(e.headers?.['retry-after'])
      return { kind: 'transient', retryAfterMs }
    }
    if (status >= 500 && status <= 599) return { kind: 'transient', retryAfterMs: e.retryAfterMs }
    return { kind: 'logical', retryAfterMs: undefined } // other 4xx
  }

  // Unknown → logical: do not blindly retry an error we don't understand.
  return { kind: 'logical', retryAfterMs: undefined }
}
