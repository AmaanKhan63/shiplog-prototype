import { Worker, type ConnectionOptions, type Queue } from 'bullmq'
import { makeNangoSyncProcessor, type NangoSyncResult } from '../nango/syncProcessor.js'
import { computeBackoff } from './backoff.js'
import { NANGO_SYNC_QUEUE } from './queues.js'
import { config } from '../config/env.js'
import type { NangoClientLike } from '../nango/types.js'
import type { IngestJobData, NangoSyncJobData, LoggerLike } from './types.js'

export interface CreateNangoSyncWorkerOptions {
  connection: ConnectionOptions
  ingestQueue: Queue<IngestJobData>
  nango: NangoClientLike
  baseMs?: number
  concurrency?: number
  logger?: LoggerLike
}

/**
 * Worker for the nango-sync queue: fetches changed records via Nango's records
 * API and fans them out as ingest jobs. Retries transient fetch failures with
 * the same exponential-backoff strategy as the ingest worker.
 */
export function createNangoSyncWorker({
  connection,
  ingestQueue,
  nango,
  baseMs = config.backoffBaseMs,
  concurrency = 5,
  logger = console,
}: CreateNangoSyncWorkerOptions) {
  const worker = new Worker<NangoSyncJobData, NangoSyncResult>(NANGO_SYNC_QUEUE, makeNangoSyncProcessor({ nango, ingestQueue }), {
    connection,
    concurrency,
    settings: {
      backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) => {
        const delay = computeBackoff(attemptsMade, { baseMs, retryAfterMs: (err as { retryAfterMs?: number })?.retryAfterMs })
        logger.log(`[nango-sync backoff] attempt ${attemptsMade} -> retry in ${delay}ms`)
        return delay
      },
    },
  })

  worker.on('error', (err) => logger.error(`[nango-sync] error: ${err?.message}`))
  worker.on('completed', (job, result) =>
    logger.log(`[nango-sync] ${job.data.model}: fetched ${result?.fetched ?? 0}, enqueued ${result?.enqueued ?? 0} ingest job(s)`))
  worker.on('failed', (job, err) => logger.error(`[nango-sync] job ${job?.id} failed: ${err?.message}`))

  return worker
}
