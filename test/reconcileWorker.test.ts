import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import type { Queue } from 'bullmq'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { Connection, RawRecord, SyncState } from '../src/models/index.js'
import { makeReconcileWorkerProcessor, scheduleReconcileSweep, RECONCILE_SWEEP_JOB } from '../src/queue/reconcileWorker.js'
import type { IngestJobData, ReconcileJobData } from '../src/queue/types.js'

function fakeQueue() {
  const added: any[] = []
  return { added, add: async (name: string, data: any, opts?: any) => { added.push({ name, data, opts }); return { id: opts?.jobId ?? `j${added.length}` } } }
}
function fakeNango(records: any[]) {
  return { calls: [] as any[], async listRecords(args: any) { this.calls.push(args); return { records, next_cursor: null } } }
}
const issue = (id: string, cursor: string) => ({ id, number: 1, title: 'I', html_url: 'https://github.com/a/b/issues/1', user: { login: 'x' }, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', _nango_metadata: { cursor } })

let tenantId: mongoose.Types.ObjectId
beforeAll(async () => { await connectTestDB(); await Promise.all([Connection.syncIndexes(), RawRecord.syncIndexes(), SyncState.syncIndexes()]) })
afterAll(dropAndClose)
beforeEach(async () => { await clearDB(); tenantId = new mongoose.Types.ObjectId() })

describe('reconcile worker dispatch', () => {
  it('dispatches a "sweep" job to the fan-out (one reconcile job per active connection x model)', async () => {
    await Connection.create({ tenantId, nangoConnectionId: 'nc-1', nangoIntegrationId: 'github', status: 'active', models: ['GithubIssue'] })
    const reconcileQueue = fakeQueue()
    const processor = makeReconcileWorkerProcessor({ nango: fakeNango([]), ingestQueue: fakeQueue() as unknown as Queue<IngestJobData>, reconcileQueue: reconcileQueue as unknown as Queue })

    const result = await processor({ name: 'sweep', data: {} })
    expect(result).toMatchObject({ swept: 1 })
    expect(reconcileQueue.added).toHaveLength(1)
    expect(reconcileQueue.added[0].data.model).toBe('GithubIssue')
  })

  it('dispatches a "reconcile" job to the poller (lands raw, advances cursor)', async () => {
    const connectionId = new mongoose.Types.ObjectId()
    const ingestQueue = fakeQueue()
    const processor = makeReconcileWorkerProcessor({ nango: fakeNango([issue('r1', 'c-1')]), ingestQueue: ingestQueue as unknown as Queue<IngestJobData>, reconcileQueue: fakeQueue() as unknown as Queue })

    const result = await processor({ name: 'reconcile', data: { tenantId, connectionId, nangoConnectionId: 'nc-1', providerConfigKey: 'github', model: 'GithubIssue' } as unknown as ReconcileJobData })
    expect(result).toMatchObject({ fetched: 1, enqueued: 1, cursor: 'c-1' })
    expect(ingestQueue.added).toHaveLength(1)
    expect((await SyncState.findOne({ tenantId, connectionId, model: 'GithubIssue' }).lean())!.cursor).toBe('c-1')
  })

  it('schedules the sweep with a template name that matches the dispatch key', async () => {
    // Guards against the scheduler template name and the worker's dispatch key
    // drifting apart (which would silently route sweeps to the reconcile branch).
    let captured: any
    const fakeQueue = { upsertJobScheduler: async (id: string, repeat: any, template: any) => { captured = { id, repeat, template }; return {} } }
    await scheduleReconcileSweep(fakeQueue as unknown as Queue, { every: 1234 })
    expect(captured.template.name).toBe(RECONCILE_SWEEP_JOB)
    expect(captured.repeat.every).toBe(1234)
  })
})
