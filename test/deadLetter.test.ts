import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { DeadLetter } from '../src/models/index.js'
import { isTerminalFailure, buildDeadLetterDoc, persistDeadLetter } from '../src/queue/deadLetter.js'
import type { IngestJobData, JobView } from '../src/queue/types.js'

const unrecoverable = () => Object.assign(new Error('bad payload'), { name: 'UnrecoverableError' })
const transient = () => Object.assign(new Error('503'), { name: 'TransientError', kind: 'transient' })

function failedJob(overrides = {}): JobView<IngestJobData> {
  return {
    data: { tenantId: new mongoose.Types.ObjectId(), connectionId: new mongoose.Types.ObjectId(), syncRunId: new mongoose.Types.ObjectId(), record: { id: 'r1' } },
    attemptsMade: 5,
    opts: { attempts: 5 },
    ...overrides,
  } as unknown as JobView<IngestJobData>
}

describe('isTerminalFailure', () => {
  it('is terminal immediately for an UnrecoverableError (logical, no retry)', () => {
    expect(isTerminalFailure({ attemptsMade: 1, opts: { attempts: 5 } } as JobView<unknown>, unrecoverable())).toBe(true)
  })

  it('is not terminal while transient attempts remain', () => {
    expect(isTerminalFailure({ attemptsMade: 2, opts: { attempts: 5 } } as JobView<unknown>, transient())).toBe(false)
  })

  it('is terminal once transient attempts are exhausted', () => {
    expect(isTerminalFailure({ attemptsMade: 5, opts: { attempts: 5 } } as JobView<unknown>, transient())).toBe(true)
  })
})

describe('buildDeadLetterDoc', () => {
  it('captures full failure context', () => {
    const job = failedJob()
    const err = Object.assign(new Error('kaboom'), { stack: 'Error: kaboom\n  at x' })
    const doc = buildDeadLetterDoc(job, err)
    expect(doc).toMatchObject({
      tenantId: job.data.tenantId,
      connectionId: job.data.connectionId,
      syncRunId: job.data.syncRunId,
      payload: job.data,
      errorMessage: 'kaboom',
      errorStack: 'Error: kaboom\n  at x',
      attemptsMade: 5,
    })
    expect(doc.failedAt).toBeInstanceOf(Date)
  })
})

describe('persistDeadLetter', () => {
  beforeAll(async () => { await connectTestDB(); await DeadLetter.syncIndexes() })
  afterAll(dropAndClose)
  beforeEach(clearDB)

  it('writes a dead_letter document with full context', async () => {
    const job = failedJob()
    const err = Object.assign(new Error('downstream 500'), { name: 'TransientError' })
    const doc = await persistDeadLetter(job, err)

    const stored = await DeadLetter.findById(doc._id).lean()
    expect(stored).toBeTruthy()
    expect(String(stored!.tenantId)).toBe(String(job.data.tenantId))
    expect(stored!.errorMessage).toBe('downstream 500')
    expect(stored!.attemptsMade).toBe(5)
    expect(stored!.payload).toMatchObject({ record: { id: 'r1' } })
    expect(await DeadLetter.countDocuments({})).toBe(1)
  })
})
