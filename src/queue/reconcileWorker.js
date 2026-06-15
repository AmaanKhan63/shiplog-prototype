import { Worker } from 'bullmq'
import { makeReconcileProcessor } from '../nango/reconcileProcessor.js'
import { makeReconcileSweep } from './reconcileSweep.js'
import { computeBackoff } from './backoff.js'
import { RECONCILE_QUEUE } from './queues.js'
import { config } from '../config/env.js'

export const RECONCILE_SWEEP_JOB = 'sweep'
const SWEEP_SCHEDULER_ID = 'reconcile-sweep'

/**
 * One processor handling both job kinds on the reconcile queue:
 *   - "sweep"     (the repeatable tick) → fan out a reconcile job per active
 *                  connection × model.
 *   - "reconcile" (per connection+model) → poll Nango on the durable cursor,
 *                  land records, advance the cursor only after a page lands.
 */
export function makeReconcileWorkerProcessor({ nango, ingestQueue, reconcileQueue }) {
  const sweep = makeReconcileSweep({ reconcileQueue })
  const reconcile = makeReconcileProcessor({ nango, ingestQueue })
  return (job) => (job.name === RECONCILE_SWEEP_JOB ? sweep(job) : reconcile(job))
}

/**
 * Register (or update) the repeatable sweep on the reconcile queue. BullMQ job
 * schedulers replace the deprecated `repeat` option; the template `name` becomes
 * the produced job's name, which is how the worker routes it to the sweep.
 * Idempotent — safe to call on every worker boot. Register this once, in the
 * worker process (not the API).
 */
export function scheduleReconcileSweep(reconcileQueue, { every = config.reconcileEveryMs } = {}) {
  return reconcileQueue.upsertJobScheduler(
    SWEEP_SCHEDULER_ID,
    { every },
    { name: RECONCILE_SWEEP_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: true } }
  )
}

export function createReconcileWorker({ connection, nango, ingestQueue, reconcileQueue, baseMs = config.backoffBaseMs, concurrency = 5, logger = console }) {
  const worker = new Worker(RECONCILE_QUEUE, makeReconcileWorkerProcessor({ nango, ingestQueue, reconcileQueue }), {
    connection,
    concurrency,
    settings: {
      backoffStrategy: (attemptsMade, _type, err) => {
        const delay = computeBackoff(attemptsMade, { baseMs, retryAfterMs: err?.retryAfterMs })
        logger.log(`[reconcile backoff] attempt ${attemptsMade} -> retry in ${delay}ms`)
        return delay
      },
    },
  })

  worker.on('error', (err) => logger.error(`[reconcile] error: ${err?.message}`))
  worker.on('completed', (job, result) => {
    if (job.name === RECONCILE_SWEEP_JOB) logger.log(`[reconcile] sweep -> ${result?.swept ?? 0} connection-model job(s)`)
    else logger.log(`[reconcile] ${job.data?.model ?? job.name}: fetched ${result?.fetched ?? 0}, enqueued ${result?.enqueued ?? 0}, cursor=${result?.cursor ?? '∅'}`)
  })
  worker.on('failed', (job, err) => logger.error(`[reconcile] job ${job?.id} (${job?.name}) failed: ${err?.message}`))

  return worker
}
