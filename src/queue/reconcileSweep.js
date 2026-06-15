import { Connection } from '../models/index.js'

export const RECONCILE_JOB = 'reconcile'

/**
 * Build the data + opts for a single per-(connection, model) reconcile job.
 *
 * The jobId is deterministic (`reconcile:<connectionId>:<model>`) so a manual
 * POST /reconcile and a scheduled sweep tick collapse onto the SAME job instead
 * of running two reconciles that race the same cursor. (Downstream ingest is
 * idempotent regardless, but this keeps the cursor single-writer.)
 */
export function reconcileJobFor(connection, model) {
  return {
    data: {
      tenantId: String(connection.tenantId),
      connectionId: String(connection._id),
      nangoConnectionId: connection.nangoConnectionId,
      providerConfigKey: connection.nangoIntegrationId,
      model,
    },
    opts: { jobId: `reconcile:${connection._id}:${model}` },
  }
}

export async function enqueueReconcileJob(reconcileQueue, connection, model) {
  const { data, opts } = reconcileJobFor(connection, model)
  return reconcileQueue.add(RECONCILE_JOB, data, opts)
}

/**
 * The repeatable "sweep": on each tick, fan out a reconcile job for every active
 * connection × model. This is what the BullMQ job scheduler fires; it's the
 * generic poller that catches anything the webhooks missed.
 */
export function makeReconcileSweep({ reconcileQueue }) {
  return async function reconcileSweep() {
    const connections = await Connection.find({ status: 'active', nangoConnectionId: { $ne: null } }).lean()
    let swept = 0
    for (const connection of connections) {
      const models = connection.models?.length ? connection.models : ['GithubIssue']
      for (const model of models) {
        await enqueueReconcileJob(reconcileQueue, connection, model)
        swept += 1
      }
    }
    return { swept }
  }
}
