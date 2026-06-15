import { UnrecoverableError } from 'bullmq'
import { normalizeGithubRecord } from '../normalize/github.js'
import { ingestEvent } from '../events/ingest.js'
import { classifyError, TransientError, LogicalError } from './errors.js'

/**
 * Process one ingest job: normalize the Nango record and idempotently upsert it
 * into the event spine. Idempotency (Milestone 1) is what makes retries and DLQ
 * replays safe — re-processing the same record can't duplicate.
 *
 * Failure injection (for the demo): `job.data.poison` or `record.__poison` set to
 * 'transient' | 'logical' forces the corresponding failure path.
 *
 * Error policy via the classifier:
 *   - logical  → wrapped in UnrecoverableError so BullMQ fails it immediately
 *                (straight to the DLQ, no retry)
 *   - transient→ rethrown unchanged so BullMQ retries it with backoff
 */
export async function ingestProcessor(job) {
  const { tenantId, record, poison } = job.data

  try {
    const injected = poison ?? record?.__poison
    if (injected === 'transient') throw new TransientError('injected transient failure', { statusCode: 503 })
    if (injected === 'logical') throw new LogicalError('injected logical failure')

    const normalized = normalizeGithubRecord(record)
    return await ingestEvent(normalized, { tenantId })
  } catch (err) {
    const { kind } = classifyError(err)
    if (kind === 'logical') {
      const unrecoverable = new UnrecoverableError(err.message)
      unrecoverable.cause = err
      throw unrecoverable
    }
    throw err // transient → let BullMQ retry with backoff
  }
}
