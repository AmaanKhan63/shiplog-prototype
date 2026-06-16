import type { Queue } from 'bullmq'
import type { Types } from 'mongoose'
import { Connection } from '../models/index.js'
import type { ReconcileJobData } from './types.js'

export const RECONCILE_JOB = 'reconcile'

// The fields of a Connection a reconcile job needs (satisfied by both a
// hydrated doc and a `.lean()` result).
export interface ReconcileConnection {
  _id: Types.ObjectId
  tenantId: Types.ObjectId
  nangoConnectionId?: string | null
  nangoIntegrationId?: string | null
  models?: string[]
}

/**
 * Build the data + opts for a single per-(connection, model) reconcile job.
 *
 * The jobId is deterministic (`reconcile:<connectionId>:<model>`) so a manual
 * POST /reconcile and a scheduled sweep tick collapse onto the SAME job instead
 * of running two reconciles that race the same cursor. (Downstream ingest is
 * idempotent regardless, but this keeps the cursor single-writer.)
 */
export function reconcileJobFor(connection: ReconcileConnection, model: string): { data: ReconcileJobData; opts: { jobId: string } } {
  return {
    data: {
      tenantId: String(connection.tenantId),
      connectionId: String(connection._id),
      // Non-null by the time a reconcile job is built (the sweep filters on
      // nangoConnectionId; the manual route loads an existing connection).
      nangoConnectionId: connection.nangoConnectionId as string,
      providerConfigKey: connection.nangoIntegrationId as string,
      model,
    },
    opts: { jobId: `reconcile:${connection._id}:${model}` },
  }
}

export async function enqueueReconcileJob(reconcileQueue: Queue, connection: ReconcileConnection, model: string) {
  const { data, opts } = reconcileJobFor(connection, model)
  return reconcileQueue.add(RECONCILE_JOB, data, opts)
}

/**
 * The repeatable "sweep": on each tick, fan out a reconcile job for every active
 * connection × model. This is what the BullMQ job scheduler fires; it's the
 * generic poller that catches anything the webhooks missed.
 */
export function makeReconcileSweep({ reconcileQueue }: { reconcileQueue: Queue }) {
  return async function reconcileSweep(): Promise<{ swept: number }> {
    const connections = await Connection.find({ status: 'active', nangoConnectionId: { $ne: null } }).lean()
    let swept = 0
    for (const connection of connections) {
      const models = connection.models?.length ? connection.models : ['Commit']
      for (const model of models) {
        await enqueueReconcileJob(reconcileQueue, connection, model)
        swept += 1
      }
    }
    return { swept }
  }
}
