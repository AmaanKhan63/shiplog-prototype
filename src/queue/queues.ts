import { Queue, type ConnectionOptions } from 'bullmq'
import type { IngestJobData, NangoSyncJobData, ReconcileQueueJobData } from './types.js'

export const INGEST_QUEUE = 'ingest'
export const DLQ = 'dlq'
export const NANGO_SYNC_QUEUE = 'nango-sync'
export const RECONCILE_QUEUE = 'nango-reconcile'

/**
 * Default options for every ingest job. `attempts` + a `custom` backoff type are
 * mandatory here: without `backoff: { type: 'custom' }` BullMQ ignores the
 * worker's backoffStrategy and retries with zero delay.
 */
export const ingestJobOptions = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
}

export function createIngestQueue(connection: ConnectionOptions) {
  return new Queue<IngestJobData>(INGEST_QUEUE, { connection, defaultJobOptions: ingestJobOptions })
}

export function createDlqQueue(connection: ConnectionOptions) {
  return new Queue(DLQ, {
    connection,
    defaultJobOptions: { removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 } },
  })
}

// Sync notifications from Nango webhooks: a worker fetches the changed records via
// the records API and fans them out as per-record ingest jobs.
export function createNangoSyncQueue(connection: ConnectionOptions) {
  return new Queue<NangoSyncJobData>(NANGO_SYNC_QUEUE, { connection, defaultJobOptions: ingestJobOptions })
}

/**
 * Reconcile jobs use a deterministic per-(connection, model) jobId, so a manual
 * trigger and a scheduled sweep tick collapse onto ONE in-flight job instead of
 * racing the same cursor. That makes prompt terminal removal important: a
 * retained completed/failed job keeps its jobId and would suppress the *next*
 * trigger — so remove on complete and on fail to keep it re-triggerable. The
 * durable cursor (sync_state) is the real record of progress, not the job.
 */
export const reconcileJobOptions = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: true,
  removeOnFail: true,
}

// Reconciliation poller: holds the repeatable sweep + per-connection reconcile
// jobs. Transient records-API outages retry; the durable cursor stays put until
// a page lands.
export function createReconcileQueue(connection: ConnectionOptions) {
  return new Queue<ReconcileQueueJobData>(RECONCILE_QUEUE, { connection, defaultJobOptions: reconcileJobOptions })
}
