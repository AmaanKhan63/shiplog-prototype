import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { Event } from '../src/models/index.js'
import { ingestProcessor } from '../src/queue/ingestProcessor.js'
import { githubFixtures } from '../src/fixtures/github.js'

let tenantId: mongoose.Types.ObjectId
const issue = githubFixtures[0]

const job = (data: any) => ({ data, attemptsMade: 0, opts: { attempts: 5 } })

beforeAll(async () => {
  await connectTestDB()
  await Event.syncIndexes()
})
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantId = new mongoose.Types.ObjectId()
})

describe('ingestProcessor', () => {
  it('normalizes and idempotently ingests a record', async () => {
    const res = await ingestProcessor(job({ tenantId, record: issue }))
    expect(res.status).toBe('added')
    expect(await Event.countDocuments({ tenantId })).toBe(1)
  })

  it('is idempotent across re-processing (retry-safe)', async () => {
    await ingestProcessor(job({ tenantId, record: issue }))
    const res = await ingestProcessor(job({ tenantId, record: issue }))
    expect(res.status).toBe('unchanged')
    expect(await Event.countDocuments({ tenantId })).toBe(1)
  })

  it('rethrows an injected transient failure (so BullMQ will retry)', async () => {
    const err = await ingestProcessor(job({ tenantId, record: issue, poison: 'transient' })).catch((e) => e)
    expect(err.kind).toBe('transient')
    expect(err.name).not.toBe('UnrecoverableError')
  })

  it('converts an injected logical failure into UnrecoverableError (no retry)', async () => {
    const err = await ingestProcessor(job({ tenantId, record: issue, poison: 'logical' })).catch((e) => e)
    expect(err.name).toBe('UnrecoverableError')
  })

  it('attaches a parsed Retry-After (429) to the thrown error so backoff can honor it', async () => {
    const err = await ingestProcessor(job({ tenantId, record: issue, poison: 'ratelimit' })).catch((e) => e)
    expect(err.name).not.toBe('UnrecoverableError') // transient -> retried
    expect(err.retryAfterMs).toBe(2000)
  })

  it('fails via an external failMode toggle even when the payload is clean', async () => {
    const errT = await ingestProcessor(job({ tenantId, record: issue }), { failMode: 'transient' }).catch((e) => e)
    expect(errT.kind).toBe('transient')
    const errL = await ingestProcessor(job({ tenantId, record: issue }), { failMode: 'logical' }).catch((e) => e)
    expect(errL.name).toBe('UnrecoverableError')
  })

  it('ingests normally when failMode is null (the recovered state)', async () => {
    const res = await ingestProcessor(job({ tenantId, record: issue }), { failMode: null })
    expect(res.status).toBe('added')
  })

  it('honors a poison marker on the record itself', async () => {
    const err = await ingestProcessor(job({ tenantId, record: { ...issue, __poison: 'logical' } })).catch((e) => e)
    expect(err.name).toBe('UnrecoverableError')
  })

  it('treats an unmappable record as logical (UnrecoverableError, no retry)', async () => {
    const err = await ingestProcessor(job({ tenantId, record: { _nango_metadata: { model: 'GithubGist' } } })).catch((e) => e)
    expect(err.name).toBe('UnrecoverableError')
  })

  it('treats a record that fails schema validation as logical', async () => {
    const noUrl = { ...issue, html_url: undefined }
    const err = await ingestProcessor(job({ tenantId, record: noUrl })).catch((e) => e)
    expect(err.name).toBe('UnrecoverableError')
  })
})
