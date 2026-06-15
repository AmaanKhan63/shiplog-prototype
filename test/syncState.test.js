import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { SyncState } from '../src/models/index.js'

let tenantId, connectionId

beforeAll(async () => { await connectTestDB(); await SyncState.syncIndexes() })
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantId = new mongoose.Types.ObjectId()
  connectionId = new mongoose.Types.ObjectId()
})

describe('SyncState (reconciliation cursor)', () => {
  it('persists a cursor per {tenantId, connectionId, model}', async () => {
    await SyncState.create({ tenantId, connectionId, model: 'GithubIssue', cursor: 'c-102' })
    const found = await SyncState.findOne({ tenantId, connectionId, model: 'GithubIssue' }).lean()
    expect(found.cursor).toBe('c-102')
  })

  it('keeps independent cursors for different models on the same connection', async () => {
    await SyncState.create({ tenantId, connectionId, model: 'GithubIssue', cursor: 'c-issue' })
    await SyncState.create({ tenantId, connectionId, model: 'GithubPullRequest', cursor: 'c-pr' })
    const issue = await SyncState.findOne({ tenantId, connectionId, model: 'GithubIssue' }).lean()
    const pr = await SyncState.findOne({ tenantId, connectionId, model: 'GithubPullRequest' }).lean()
    expect(issue.cursor).toBe('c-issue')
    expect(pr.cursor).toBe('c-pr')
  })

  it('enforces one cursor row per {tenantId, connectionId, model} (unique index)', async () => {
    await SyncState.create({ tenantId, connectionId, model: 'GithubIssue', cursor: 'c-1' })
    await expect(
      SyncState.create({ tenantId, connectionId, model: 'GithubIssue', cursor: 'c-2' })
    ).rejects.toThrow(/duplicate key/i)
  })
})
