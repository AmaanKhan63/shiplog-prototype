import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { RawRecord, SyncState } from '../src/models/index.js'
import { makeReconcileProcessor } from '../src/nango/reconcileProcessor.js'
import type { Queue } from 'bullmq'
import type { IngestJobData } from '../src/queue/types.js'

let tenantId: mongoose.Types.ObjectId, connectionId: mongoose.Types.ObjectId

function fakeQueue() {
  const added: any[] = []
  return { added, add: async (name: string, data: any, opts?: any) => { added.push({ name, data, opts }); return { id: `j${added.length}` } } } as unknown as Queue<IngestJobData> & { added: any[] }
}

// Fake Nango client driven by a sequence of pages. A page may be the string
// 'THROW' to simulate a transient records-API outage on that call.
function fakeNango(pages: any[]) {
  let i = 0
  return {
    calls: [] as any[],
    async listRecords(args: any) {
      this.calls.push(args)
      const page = pages[i++]
      if (page === 'THROW') { const e = new Error('Nango records API unavailable'); (e as any).kind = 'transient'; throw e }
      return page ?? { records: [], next_cursor: null }
    },
  }
}

// A Nango that always returns the SAME page — so a missing termination guard
// would loop forever. The call counter caps it so the test fails loudly instead
// of hanging.
function loopingNango(page: any, cap = 50) {
  return { calls: 0, async listRecords() { this.calls += 1; if (this.calls > cap) throw new Error(`looped ${this.calls} times`); return page } }
}

// A fake ingest queue whose Nth add() throws — to exercise a mid-page failure.
function failingIngestQueue(failOnNth: number) {
  let n = 0
  const added: any[] = []
  return { added, add: async (name: string, data: any) => { n += 1; if (n === failOnNth) throw new Error('ingest enqueue failed'); added.push({ name, data }); return { id: `j${n}` } } } as unknown as Queue<IngestJobData> & { added: any[] }
}

const issue = (id: any, number: any, cursor: any) => ({
  id, number, title: `Issue ${number}`, html_url: `https://github.com/acme/app/issues/${number}`,
  user: { login: 'octocat' }, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
  _nango_metadata: { cursor }, // no model — the processor stamps it
})

const job = (data?: any) => ({ data: { tenantId, connectionId, nangoConnectionId: 'nc-1', providerConfigKey: 'github', model: 'GithubIssue', ...data } })
const cursorOf = () => SyncState.findOne({ tenantId, connectionId, model: 'GithubIssue' }).lean()

beforeAll(async () => { await connectTestDB(); await Promise.all([RawRecord.syncIndexes(), SyncState.syncIndexes()]) })
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantId = new mongoose.Types.ObjectId()
  connectionId = new mongoose.Types.ObjectId()
})

describe('reconcile processor', () => {
  it('lands raw + enqueues one ingest job per record, stamping the model', async () => {
    const nango = fakeNango([{ records: [issue('r1', 1, 'c-1')], next_cursor: null }])
    const ingestQueue = fakeQueue()
    const result = await makeReconcileProcessor({ nango, ingestQueue })(job())

    expect(result).toMatchObject({ fetched: 1, enqueued: 1 })
    expect(ingestQueue.added).toHaveLength(1)
    expect(ingestQueue.added[0].data.record._nango_metadata.model).toBe('GithubIssue')
    expect(await RawRecord.countDocuments({ tenantId })).toBe(1)
  })

  it('skips deleted records (tombstones)', async () => {
    const deleted = { id: 'r9', _nango_metadata: { cursor: 'c-9', deleted_at: '2024-02-01T00:00:00Z' } }
    const nango = fakeNango([{ records: [issue('r1', 1, 'c-1'), deleted], next_cursor: null }])
    const result = await makeReconcileProcessor({ nango, ingestQueue: fakeQueue() })(job())
    expect(result).toMatchObject({ fetched: 2, enqueued: 1 })
  })

  it('advances the cursor to the last record\'s _nango_metadata.cursor on success', async () => {
    const nango = fakeNango([{ records: [issue('r1', 1, 'c-1'), issue('r2', 2, 'c-2')], next_cursor: null }])
    await makeReconcileProcessor({ nango, ingestQueue: fakeQueue() })(job())
    expect((await cursorOf())!.cursor).toBe('c-2')
  })

  it('does NOT advance the cursor when the records fetch fails', async () => {
    await SyncState.create({ tenantId, connectionId, model: 'GithubIssue', cursor: 'c-old' })
    const nango = fakeNango(['THROW'])
    await expect(makeReconcileProcessor({ nango, ingestQueue: fakeQueue() })(job())).rejects.toThrow(/unavailable/i)
    expect((await cursorOf())!.cursor).toBe('c-old') // unchanged — the failed fetch wrote nothing
    expect(await RawRecord.countDocuments({ tenantId })).toBe(0)
  })

  it('resumes from the persisted cursor (passes it to listRecords)', async () => {
    await SyncState.create({ tenantId, connectionId, model: 'GithubIssue', cursor: 'c-resume' })
    const nango = fakeNango([{ records: [], next_cursor: null }])
    await makeReconcileProcessor({ nango, ingestQueue: fakeQueue() })(job())
    expect(nango.calls[0].cursor).toBe('c-resume')
  })

  it('paginates via next_cursor and checkpoints per page (mid-run failure keeps the page-1 cursor)', async () => {
    const nango = fakeNango([
      { records: [issue('r1', 1, 'c-1')], next_cursor: 'page2' },
      'THROW', // page 2 fetch fails after page 1 is durably landed
    ])
    const ingestQueue = fakeQueue()
    await expect(makeReconcileProcessor({ nango, ingestQueue })(job())).rejects.toThrow()

    // Page 1 was durably landed + checkpointed before page 2 failed.
    expect(ingestQueue.added).toHaveLength(1)
    expect((await cursorOf())!.cursor).toBe('c-1')
    // Page 2 was requested with the next_cursor from page 1.
    expect(nango.calls[1].cursor).toBe('page2')
  })

  it('terminates on an empty page even if next_cursor is non-null (no infinite loop)', async () => {
    const nango = loopingNango({ records: [], next_cursor: 'still-more' })
    const result = await makeReconcileProcessor({ nango, ingestQueue: fakeQueue() })(job())
    expect(result).toMatchObject({ fetched: 0, enqueued: 0 })
    expect(nango.calls).toBe(1) // did not loop
  })

  it('terminates when next_cursor does not advance (no infinite loop)', async () => {
    const nango = loopingNango({ records: [issue('r1', 1, 'c-1')], next_cursor: 'stuck' })
    const result = await makeReconcileProcessor({ nango, ingestQueue: fakeQueue() })(job())
    expect(result.cursor).toBe('c-1')
    expect(nango.calls).toBe(2) // requested next page once, saw the same token, stopped
  })

  it('falls back to next_cursor when the last record has no _nango_metadata.cursor', async () => {
    const noCursor = { id: 'r1', number: 1, title: 'I', html_url: 'https://github.com/a/b/issues/1', user: { login: 'x' }, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', _nango_metadata: {} }
    const nango = fakeNango([{ records: [noCursor], next_cursor: 'np-1' }])
    await makeReconcileProcessor({ nango, ingestQueue: fakeQueue() })(job())
    expect((await cursorOf())!.cursor).toBe('np-1') // advanced via next_cursor, not stuck
  })

  it('holds the cursor when an enqueue fails mid-page', async () => {
    await SyncState.create({ tenantId, connectionId, model: 'GithubIssue', cursor: 'c-old' })
    const nango = fakeNango([{ records: [issue('r1', 1, 'c-1'), issue('r2', 2, 'c-2')], next_cursor: null }])
    await expect(makeReconcileProcessor({ nango, ingestQueue: failingIngestQueue(2) })(job())).rejects.toThrow(/enqueue failed/i)
    expect((await cursorOf())!.cursor).toBe('c-old') // checkpoint is after the page loop — a mid-page throw never reaches it
  })

  it('reports the final cursor in its result', async () => {
    const nango = fakeNango([
      { records: [issue('r1', 1, 'c-1')], next_cursor: 'page2' },
      { records: [issue('r2', 2, 'c-2')], next_cursor: null },
    ])
    const result = await makeReconcileProcessor({ nango, ingestQueue: fakeQueue() })(job())
    expect(result).toMatchObject({ fetched: 2, enqueued: 2, cursor: 'c-2' })
  })
})
