import { Worker, type ConnectionOptions, type Job, type Queue } from 'bullmq'
import { ingestProcessor } from './ingestProcessor.js'
import { computeBackoff } from './backoff.js'
import { isTerminalFailure, persistDeadLetter } from './deadLetter.js'
import { INGEST_QUEUE } from './queues.js'
import { config } from '../config/env.js'
import type { FailMode, IngestJobData, JobView, LoggerLike } from './types.js'

function describeJob(job?: JobView<IngestJobData>): string {
  const r = job?.data?.record as Record<string, any> | undefined
  const model = r?._nango_metadata?.model
  if (job?.data?.poison) return `poison:${job.data.poison}`
  if (model) return `${model} ${r?.number ?? r?.sha ?? ''}`.trim()
  return 'record'
}

export interface CreateIngestWorkerOptions {
  connection: ConnectionOptions
  dlqQueue?: Queue
  baseMs?: number
  concurrency?: number
  logger?: LoggerLike
  getFailMode?: () => FailMode | null | undefined
}

/**
 * Create the ingest Worker, wired with:
 *   - a custom exponential-backoff-with-jitter strategy that honors Retry-After
 *     and logs each scheduled delay (the "visible backoff" in the demo)
 *   - a `failed` handler that, on terminal failure, persists full context to the
 *     dead_letter collection (and parks a replay job on the dlq queue)
 *
 * Shared by the standalone worker process (src/worker.ts) and the integration
 * test, so both exercise identical wiring.
 */
export function createIngestWorker({
  connection,
  dlqQueue,
  baseMs = config.backoffBaseMs,
  concurrency = 5,
  logger = console,
  getFailMode,
}: CreateIngestWorkerOptions) {
  // getFailMode() is read per-job, so an external outage can be toggled live
  // (used by the Milestone 3 replay demo); undefined in normal operation.
  const processor = (job: Job<IngestJobData>) => ingestProcessor(job, { failMode: getFailMode?.() })
  const worker = new Worker<IngestJobData>(INGEST_QUEUE, processor, {
    connection,
    concurrency,
    settings: {
      // Only invoked when a retry is actually scheduled (i.e. for transient
      // failures with attempts remaining). UnrecoverableError skips this.
      backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) => {
        const delay = computeBackoff(attemptsMade, { baseMs, retryAfterMs: (err as { retryAfterMs?: number })?.retryAfterMs })
        logger.log(`[backoff] attempt ${attemptsMade} failed (transient) -> retry in ${delay}ms`)
        return delay
      },
    },
  })

  // An unhandled 'error' event on an EventEmitter crashes the process — always
  // attach a listener (transient Redis blips and teardown emit benign errors).
  worker.on('error', (err) => {
    logger.error(`[worker] error: ${err?.message}`)
  })

  worker.on('completed', (job, result) => {
    logger.log(`[ok]   job ${job.id} ${describeJob(job)} -> ${result?.status ?? 'ok'}`)
  })

  worker.on('failed', async (job, err) => {
    if (!job) {
      logger.error(`[fail] worker error (no job): ${err?.message}`)
      return
    }
    const kind = err?.name === 'UnrecoverableError' ? 'logical' : 'transient'
    if (isTerminalFailure(job, err)) {
      try {
        const doc = await persistDeadLetter(job, err, { dlqQueue })
        logger.error(`[DLQ]  job ${job.id} ${describeJob(job)} -> dead_letter ${doc._id} after ${job.attemptsMade} attempt(s) [${kind}: ${err?.message}]`)
      } catch (persistErr) {
        logger.error(`[DLQ]  FAILED to persist dead_letter for job ${job.id}: ${(persistErr as Error)?.message}`)
      }
    } else {
      logger.error(`[fail] job ${job.id} ${describeJob(job)} attempt ${job.attemptsMade}/${job.opts.attempts} [transient: ${err?.message}]`)
    }
  })

  return worker
}
