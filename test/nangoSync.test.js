import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { RawRecord } from '../src/models/index.js'
import { makeNangoSyncProcessor } from '../src/nango/syncProcessor.js'

let tenantId, connectionId

function fakeQueue() {
  const added = []
  return { added, add: async (name, data) => { added.push({ name, data }); return { id: `j${added.length}` } } }
}

// Fake Nango client: returns the given pages in sequence (cursor-driven pagination).
function fakeNango(pages) {
  let i = 0
  return { calls: [], async listRecords(args) { this.calls.push(args); return pages[i++] ?? { records: [], next_cursor: null } } }
}

const issueRecord = (id, number) => ({
  id, number, title: `Issue ${number}`, html_url: `https://github.com/acme/app/issues/${number}`,
  user: { login: 'octocat' }, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
  _nango_metadata: { cursor: `cur-${id}` }, // note: no model — the processor stamps it
})

beforeAll(async () => { await connectTestDB(); await RawRecord.syncIndexes() })
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantId = new mongoose.Types.ObjectId()
  connectionId = new mongoose.Types.ObjectId()
})

const job = (data) => ({ data: { tenantId, connectionId, nangoConnectionId: 'nango-conn-1', providerConfigKey: 'github', model: 'GithubIssue', ...data } })

describe('nango sync processor', () => {
  it('lands raw + enqueues one ingest job per record, stamping the model', async () => {
    const nango = fakeNango([{ records: [issueRecord('r1', 1)], next_cursor: null }])
    const ingestQueue = fakeQueue()
    const result = await makeNangoSyncProcessor({ nango, ingestQueue })(job())

    expect(result).toMatchObject({ fetched: 1, enqueued: 1 })
    expect(ingestQueue.added).toHaveLength(1)
    expect(ingestQueue.added[0].data.record._nango_metadata.model).toBe('GithubIssue')
    expect(await RawRecord.countDocuments({ tenantId })).toBe(1)
  })

  it('paginates via cursor until next_cursor is empty', async () => {
    const nango = fakeNango([
      { records: [issueRecord('r1', 1)], next_cursor: 'c2' },
      { records: [issueRecord('r2', 2)], next_cursor: null },
    ])
    const ingestQueue = fakeQueue()
    const result = await makeNangoSyncProcessor({ nango, ingestQueue })(job())

    expect(result.enqueued).toBe(2)
    expect(nango.calls).toHaveLength(2)
    expect(nango.calls[1].cursor).toBe('c2')
  })

  it('skips deleted records (tombstones), not enqueuing them as live events', async () => {
    const deleted = { id: 'r9', _nango_metadata: { deleted_at: '2024-02-01T00:00:00Z' } }
    const nango = fakeNango([{ records: [issueRecord('r1', 1), deleted], next_cursor: null }])
    const ingestQueue = fakeQueue()
    const result = await makeNangoSyncProcessor({ nango, ingestQueue })(job())

    expect(result.fetched).toBe(2)
    expect(result.enqueued).toBe(1)
    expect(ingestQueue.added).toHaveLength(1)
  })

  it('passes providerConfigKey, nangoConnectionId, model and modifiedAfter to listRecords', async () => {
    const nango = fakeNango([{ records: [], next_cursor: null }])
    await makeNangoSyncProcessor({ nango, ingestQueue: fakeQueue() })(job({ modifiedAfter: '2024-03-01T00:00:00Z' }))
    expect(nango.calls[0]).toMatchObject({ providerConfigKey: 'github', connectionId: 'nango-conn-1', model: 'GithubIssue', modifiedAfter: '2024-03-01T00:00:00Z' })
  })
})
