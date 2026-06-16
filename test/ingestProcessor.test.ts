import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { Event, DeadLetter } from '../src/models/index.js'
import { ingestProcessor } from '../src/queue/ingestProcessor.js'
import { ingestEvent } from '../src/events/ingest.js'
import { normalizeGithubRecord } from '../src/normalize/github.js'
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

  // Self-healing fault used by `npm run inject recovery|duplicate`: fails
  // transiently until the record has dead-lettered, then recovers so a verbatim
  // replay succeeds — exercised here without a live worker.
  describe('demoFault (self-healing recovery/duplicate fault)', () => {
    const commit = githubFixtures.find((r) => r._nango_metadata.model === 'GithubCommit')!

    it('fails transiently (and writes nothing) while no dead_letter doc exists yet', async () => {
      const err = await ingestProcessor(job({ tenantId, record: commit, demoFault: { id: 'fault-A' } })).catch((e) => e)
      expect(err.kind).toBe('transient')
      expect(err.name).not.toBe('UnrecoverableError')
      expect(await Event.countDocuments({ tenantId })).toBe(0)
    })

    it('recovers and ingests (+1) once a dead_letter doc exists — the replay', async () => {
      await DeadLetter.create({ tenantId, payload: { tenantId: String(tenantId), demoFault: { id: 'fault-B' } } })
      const res = await ingestProcessor(job({ tenantId, record: commit, demoFault: { id: 'fault-B' } }))
      expect(res.status).toBe('added')
      expect(await Event.countDocuments({ tenantId })).toBe(1)
    })

    it('replays to a no-op (count unchanged) when the key already exists — the duplicate case', async () => {
      await ingestEvent(normalizeGithubRecord(commit), { tenantId }) // seed the target event
      await DeadLetter.create({ tenantId, payload: { tenantId: String(tenantId), demoFault: { id: 'fault-C' } } })
      const res = await ingestProcessor(job({ tenantId, record: commit, demoFault: { id: 'fault-C' } }))
      expect(res.status).toBe('unchanged')
      expect(await Event.countDocuments({ tenantId })).toBe(1)
    })

    it('heals across the string-vs-ObjectId seam — job carries tenantId as a string (the live inject path)', async () => {
      // The live inject job carries tenantId as a STRING (ensureDemoContext →
      // tenant._id.toString()), while the DLQ doc stores it as an ObjectId. The
      // heal query must still match across that cast.
      const sid = String(tenantId)
      await DeadLetter.create({ tenantId, payload: { tenantId: sid, demoFault: { id: 'fault-D' } } })
      const res = await ingestProcessor(job({ tenantId: sid, record: commit, demoFault: { id: 'fault-D' } }))
      expect(res.status).toBe('added')
      expect(await Event.countDocuments({ tenantId })).toBe(1)
    })
  })
})
