import { Worker, type ConnectionOptions, type Queue } from 'bullmq'
import { makeReconcileProcessor, type ReconcileResult } from '../nango/reconcileProcessor.js'
import { makeReconcileSweep } from './reconcileSweep.js'
import { computeBackoff } from './backoff.js'
import { RECONCILE_QUEUE } from './queues.js'
import { config } from '../config/env.js'
import type { NangoClientLike } from '../nango/types.js'
import type { IngestJobData, JobView, ReconcileJobData, ReconcileQueueJobData, LoggerLike } from './types.js'

export const RECONCILE_SWEEP_JOB = 'sweep'
const SWEEP_SCHEDULER_ID = 'reconcile-sweep'

export interface ReconcileWorkerDeps {
  nango: NangoClientLike
  ingestQueue: Queue<IngestJobData>
  reconcileQueue: Queue
}

/**
 * One processor handling both job kinds on the reconcile queue:
 *   - "sweep"     (the repeatable tick) → fan out a reconcile job per active
 *                  connection × model.
 *   - "reconcile" (per connection+model) → poll Nango on the durable cursor,
 *                  land records, advance the cursor only after a page lands.
 */
export function makeReconcileWorkerProcessor({ nango, ingestQueue, reconcileQueue }: ReconcileWorkerDeps) {
  const sweep = makeReconcileSweep({ reconcileQueue })
  const reconcile = makeReconcileProcessor({ nango, ingestQueue })
  return (job: JobView<ReconcileQueueJobData>) =>
    job.name === RECONCILE_SWEEP_JOB ? sweep() : reconcile(job as JobView<ReconcileJobData>)
}

export interface ScheduleReconcileSweepOptions {
  every?: number
}

/**
 * Register (or update) the repeatable sweep on the reconcile queue. BullMQ job
 * schedulers replace the deprecated `repeat` option; the template `name` becomes
 * the produced job's name, which is how the worker routes it to the sweep.
 * Idempotent — safe to call on every worker boot. Register this once, in the
 * worker process (not the API).
 */
export function scheduleReconcileSweep(reconcileQueue: Queue, { every = config.reconcileEveryMs }: ScheduleReconcileSweepOptions = {}) {
  return reconcileQueue.upsertJobScheduler(
    SWEEP_SCHEDULER_ID,
    { every },
    { name: RECONCILE_SWEEP_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: true } }
  )
}

export interface CreateReconcileWorkerOptions extends ReconcileWorkerDeps {
  connection: ConnectionOptions
  baseMs?: number
  concurrency?: number
  logger?: LoggerLike
}

export function createReconcileWorker({
  connection,
  nango,
  ingestQueue,
  reconcileQueue,
  baseMs = config.backoffBaseMs,
  concurrency = 5,
  logger = console,
}: CreateReconcileWorkerOptions) {
  const worker = new Worker<ReconcileQueueJobData, { swept: number } | ReconcileResult>(RECONCILE_QUEUE, makeReconcileWorkerProcessor({ nango, ingestQueue, reconcileQueue }), {
    connection,
    concurrency,
    settings: {
      backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) => {
        const delay = computeBackoff(attemptsMade, { baseMs, retryAfterMs: (err as { retryAfterMs?: number })?.retryAfterMs })
        logger.log(`[reconcile backoff] attempt ${attemptsMade} -> retry in ${delay}ms`)
        return delay
      },
    },
  })

  worker.on('error', (err) => logger.error(`[reconcile] error: ${err?.message}`))
  worker.on('completed', (job, result) => {
    const r = result as { swept?: number; fetched?: number; enqueued?: number; cursor?: string | null }
    if (job.name === RECONCILE_SWEEP_JOB) logger.log(`[reconcile] sweep -> ${r?.swept ?? 0} connection-model job(s)`)
    else logger.log(`[reconcile] ${(job.data as ReconcileJobData)?.model ?? job.name}: fetched ${r?.fetched ?? 0}, enqueued ${r?.enqueued ?? 0}, cursor=${r?.cursor ?? '∅'}`)
  })
  worker.on('failed', (job, err) => logger.error(`[reconcile] job ${job?.id} (${job?.name}) failed: ${err?.message}`))

  return worker
}
