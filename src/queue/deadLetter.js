import { DeadLetter } from '../models/index.js'

/**
 * Whether a `failed` event represents a *terminal* failure (DLQ-worthy) rather
 * than an attempt that will be retried. The Worker 'failed' event fires on every
 * attempt, so this guard decides whether we write one DLQ doc or none.
 *   - UnrecoverableError (logical) → terminal at once, no retry
 *   - transient → terminal only once attempts are exhausted
 */
export function isTerminalFailure(job, err) {
  if (err?.name === 'UnrecoverableError') return true
  const attempts = job?.opts?.attempts ?? 1
  return (job?.attemptsMade ?? 0) >= attempts
}

/** Full failure context for the dead_letter collection (no secrets in payload). */
export function buildDeadLetterDoc(job, err) {
  const { tenantId, connectionId, syncRunId } = job.data ?? {}
  return {
    tenantId,
    connectionId,
    syncRunId,
    payload: job.data,
    errorMessage: err?.message,
    errorStack: err?.stack,
    attemptsMade: job.attemptsMade,
    failedAt: new Date(),
  }
}

/**
 * Persist the failure to the durable dead_letter collection first (that's what
 * the operator inspects and what M3 replays), then park a job on the BullMQ dlq
 * queue for later replay. A dlq-enqueue hiccup must never lose the Mongo record.
 */
export async function persistDeadLetter(job, err, { dlqQueue } = {}) {
  const doc = await DeadLetter.create(buildDeadLetterDoc(job, err))
  if (dlqQueue) {
    await dlqQueue.add('dead-letter', { deadLetterId: doc._id.toString(), ...job.data })
  }
  return doc
}
