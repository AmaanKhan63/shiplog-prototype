import type { NangoRecord } from '../nango/types.js'

// On-demand failure injection used by the demos (see ingestProcessor).
export type FailMode = 'transient' | 'logical' | 'ratelimit'

// BullMQ job payloads. Secrets never travel in job data — only ids do (BullMQ
// stores job data in Redis as cleartext).
export interface IngestJobData {
  tenantId: string
  connectionId?: string
  syncRunId?: string
  record?: NangoRecord
  poison?: FailMode
  __poison?: FailMode
  // Self-healing demo fault (recovery/idempotency demos): every attempt fails
  // transiently until THIS record has dead-lettered, then the "outage" is
  // considered resolved so a verbatim /dlq/:id/replay falls through and ingests.
  // Present only on records injected by `npm run inject recovery|duplicate`.
  demoFault?: { id: string }
}

export interface NangoSyncJobData {
  tenantId: string
  connectionId: string
  nangoConnectionId: string
  providerConfigKey: string
  model: string
  modifiedAfter?: string
}

export interface ReconcileJobData {
  tenantId: string
  connectionId: string
  nangoConnectionId: string
  providerConfigKey: string
  model: string
}

// The "sweep" repeatable job carries no per-connection data.
export type ReconcileQueueJobData = ReconcileJobData | Record<string, never>

// The slice of a BullMQ Job our processors actually read. Lets unit tests pass a
// plain `{ data, name }` while the real `Job<T>` is structurally assignable.
export interface JobView<T> {
  data: T
  name?: string
  id?: string
  attemptsMade?: number
  opts?: { attempts?: number }
}

// The slice of `console` the workers/demos log through (so tests can pass a
// silent stub).
export interface LoggerLike {
  log: (message: string) => void
  error: (message: string) => void
}
