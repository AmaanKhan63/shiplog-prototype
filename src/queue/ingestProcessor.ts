import { UnrecoverableError } from 'bullmq'
import { normalizeGithubRecord } from '../normalize/github.js'
import { ingestEvent } from '../events/ingest.js'
import { classifyError, TransientError, LogicalError } from './errors.js'
import type { FailMode, IngestJobData, JobView } from './types.js'

export interface IngestProcessorOptions {
  failMode?: FailMode | null
}

/**
 * Process one ingest job: normalize the Nango record and idempotently upsert it
 * into the event spine. Idempotency (Milestone 1) is what makes retries and DLQ
 * replays safe — re-processing the same record can't duplicate.
 *
 * Failure injection:
 *   - `opts.failMode` — an EXTERNAL toggle (Milestone 3 replay demo): simulates a
 *     downstream outage independent of the payload, so it can be turned off and a
 *     verbatim replay then succeeds.
 *   - `job.data.poison` / `record.__poison` — a fault baked into the payload (M2
 *     manual injection); such an item will re-fail on replay, by design.
 * Values: 'transient' | 'logical' | 'ratelimit'.
 *
 * Error policy via the classifier:
 *   - logical  → wrapped in UnrecoverableError so BullMQ fails it immediately
 *                (straight to the DLQ, no retry)
 *   - transient→ rethrown unchanged so BullMQ retries it with backoff
 */
export async function ingestProcessor(job: JobView<IngestJobData>, { failMode }: IngestProcessorOptions = {}) {
  const { tenantId, record, poison } = job.data

  try {
    const injected = failMode ?? poison ?? record?.__poison
    if (injected === 'transient') throw new TransientError('injected transient failure', { statusCode: 503 })
    if (injected === 'logical') throw new LogicalError('injected logical failure')
    if (injected === 'ratelimit') {
      throw Object.assign(new Error('rate limited'), { statusCode: 429, headers: { 'retry-after': '2' } })
    }

    const normalized = normalizeGithubRecord(record!)
    return await ingestEvent(normalized, { tenantId })
  } catch (err) {
    const { kind, retryAfterMs } = classifyError(err)
    if (kind === 'logical') {
      const unrecoverable = new UnrecoverableError((err as Error)?.message)
      unrecoverable.cause = err
      throw unrecoverable
    }
    // Surface the classified Retry-After on the error so backoffStrategy honors it.
    const e = err as { retryAfterMs?: number }
    if (retryAfterMs != null && e.retryAfterMs == null) e.retryAfterMs = retryAfterMs
    throw err // transient → let BullMQ retry with backoff
  }
}
