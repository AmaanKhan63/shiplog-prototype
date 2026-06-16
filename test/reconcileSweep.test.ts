import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Queue } from 'bullmq'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { Connection } from '../src/models/index.js'
import { makeReconcileSweep } from '../src/queue/reconcileSweep.js'

function fakeQueue() {
  const added: any[] = []
  return { added, add: async (name: string, data: any, opts?: any) => { added.push({ name, data, opts }); return { id: opts?.jobId ?? `j${added.length}` } } }
}

let tenantId: mongoose.Types.ObjectId
beforeAll(async () => { await connectTestDB(); await Connection.syncIndexes() })
afterAll(dropAndClose)
beforeEach(async () => { await clearDB(); tenantId = new mongoose.Types.ObjectId() })

const conn = (extra = {}) =>
  Connection.create({ tenantId, provider: 'github', nangoConnectionId: 'nc-1', nangoIntegrationId: 'github', status: 'active', ...extra })

describe('Connection.models', () => {
  it('defaults to [Commit]', async () => {
    const c = await conn()
    expect(c.models).toEqual(['Commit'])
  })
})

describe('reconcile sweep', () => {
  it('enqueues one reconcile job per active connection x model', async () => {
    await conn({ models: ['GithubIssue', 'GithubPullRequest'] })
    const queue = fakeQueue()
    const result = await makeReconcileSweep({ reconcileQueue: queue as unknown as Queue })()

    expect(result).toMatchObject({ swept: 2 })
    expect(queue.added).toHaveLength(2)
    expect(queue.added.map((j) => j.data.model).sort()).toEqual(['GithubIssue', 'GithubPullRequest'])
    expect(queue.added[0].data).toMatchObject({ nangoConnectionId: 'nc-1', providerConfigKey: 'github' })
    expect(queue.added[0].name).toBe('reconcile')
  })

  it('uses a deterministic jobId so a manual trigger and a tick cannot race the same cursor', async () => {
    const c = await conn()
    const queue = fakeQueue()
    await makeReconcileSweep({ reconcileQueue: queue as unknown as Queue })()
    expect(queue.added[0].opts.jobId).toBe(`reconcile:${c._id}:Commit`)
  })

  it('skips inactive connections and connections with no nango connection id', async () => {
    await conn({ status: 'disabled' })
    await conn({ nangoConnectionId: null })
    const queue = fakeQueue()
    const result = await makeReconcileSweep({ reconcileQueue: queue as unknown as Queue })()
    expect(result.swept).toBe(0)
    expect(queue.added).toHaveLength(0)
  })
})
