import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { RawRecord } from '../src/models/index.js'
import { landRawRecord } from '../src/events/raw.js'
import { githubFixtures } from '../src/fixtures/github.js'

let tenantId, connectionId
const issue = githubFixtures[0] // { id: 'gh_issue_101', ... }

beforeAll(async () => { await connectTestDB(); await RawRecord.syncIndexes() })
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantId = new mongoose.Types.ObjectId()
  connectionId = new mongoose.Types.ObjectId()
})

describe('landRawRecord', () => {
  it('stores the raw Nango record (immutable raw layer / replay source)', async () => {
    const doc = await landRawRecord(issue, { tenantId, connectionId })
    expect(doc.nangoRecordId).toBe('gh_issue_101')
    expect(doc.source).toBe('github')
    expect(doc.payload).toMatchObject({ number: 101, title: issue.title })
    expect(await RawRecord.countDocuments({ tenantId })).toBe(1)
  })

  it('is idempotent — landing the same record twice keeps one row', async () => {
    await landRawRecord(issue, { tenantId, connectionId })
    await landRawRecord(issue, { tenantId, connectionId })
    expect(await RawRecord.countDocuments({ tenantId, connectionId })).toBe(1)
  })

  it('scopes by tenant + connection', async () => {
    const otherConn = new mongoose.Types.ObjectId()
    await landRawRecord(issue, { tenantId, connectionId })
    await landRawRecord(issue, { tenantId, connectionId: otherConn })
    expect(await RawRecord.countDocuments({ tenantId })).toBe(2)
  })
})
