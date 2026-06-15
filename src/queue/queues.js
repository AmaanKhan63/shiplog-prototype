import { Queue } from 'bullmq'

export const INGEST_QUEUE = 'ingest'
export const DLQ = 'dlq'

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

export function createIngestQueue(connection) {
  return new Queue(INGEST_QUEUE, { connection, defaultJobOptions: ingestJobOptions })
}

export function createDlqQueue(connection) {
  return new Queue(DLQ, {
    connection,
    defaultJobOptions: { removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 } },
  })
}
