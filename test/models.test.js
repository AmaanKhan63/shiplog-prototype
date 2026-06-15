import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, dropAndClose } from './helpers/db.js'
import { Tenant, Connection, SyncState, RawRecord, Event, SyncRun, DeadLetter } from '../src/models/index.js'

beforeAll(async () => {
  await connectTestDB()
  // Ensure indexes are built before asserting on them / exercising uniqueness.
  await Promise.all([
    Tenant.init(), Connection.init(), SyncState.init(),
    RawRecord.init(), Event.init(), SyncRun.init(), DeadLetter.init(),
  ])
})
afterAll(dropAndClose)

const keysOf = (indexes) => indexes.map((i) => Object.keys(i.key).join(','))

describe('models are registered', () => {
  it('registers all seven collections from spec section D', () => {
    const names = Object.keys(mongoose.models)
    for (const m of ['Tenant', 'Connection', 'SyncState', 'RawRecord', 'Event', 'SyncRun', 'DeadLetter']) {
      expect(names).toContain(m)
    }
  })
})

describe('Event indexes', () => {
  it('has a UNIQUE index on idempotencyKey', async () => {
    const indexes = await Event.collection.indexes()
    const idem = indexes.find((i) => Object.keys(i.key).join(',') === 'idempotencyKey')
    expect(idem).toBeTruthy()
    expect(idem.unique).toBe(true)
  })

  it('has compound {tenantId, externalId} and {tenantId, occurredAt} indexes', async () => {
    const keys = keysOf(await Event.collection.indexes())
    expect(keys).toContain('tenantId,externalId')
    expect(keys).toContain('tenantId,occurredAt')
  })

  it('enforces idempotencyKey uniqueness at the database level', async () => {
    const tenantId = new mongoose.Types.ObjectId()
    const doc = {
      tenantId, idempotencyKey: 'dup-key-1', type: 'issue', source: 'github',
      externalId: 'issue:1', contentHash: 'h1', actor: 'a', title: 't',
      url: 'https://x/1', occurredAt: new Date(), version: 'v1',
    }
    await Event.create(doc)
    await expect(Event.create({ ...doc, _id: undefined, externalId: 'issue:2', contentHash: 'h2' }))
      .rejects.toThrow(/E11000|duplicate key/i)
  })
})

describe('SyncState index', () => {
  it('has a {connectionId} index', async () => {
    const keys = keysOf(await SyncState.collection.indexes())
    expect(keys).toContain('connectionId')
  })
})

describe('SyncRun counts shape', () => {
  it('defaults counts to zeros', async () => {
    const run = await SyncRun.create({ tenantId: new mongoose.Types.ObjectId(), trigger: 'reconcile' })
    expect(run.counts.toObject ? run.counts.toObject() : run.counts).toMatchObject({ added: 0, updated: 0, deleted: 0, failed: 0 })
  })
})
