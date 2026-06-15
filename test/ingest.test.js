import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import mongoose from 'mongoose'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { Event } from '../src/models/index.js'
import { ingestEvent, ingestNangoRecords } from '../src/events/ingest.js'
import { githubFixtures } from '../src/fixtures/github.js'

let tenantId

beforeAll(async () => {
  await connectTestDB()
  await Event.syncIndexes()
})
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantId = new mongoose.Types.ObjectId()
})

function issueEvent(overrides = {}) {
  return {
    source: 'github', type: 'issue', externalId: 'issue:42', actor: 'octocat',
    title: 'Login broken', url: 'https://github.com/acme/app/issues/42',
    occurredAt: new Date('2024-01-01T10:00:00Z'), version: '2024-01-02T10:00:00Z',
    ...overrides,
  }
}

describe('ingesting a batch of Nango records', () => {
  it('counts every record as added on first ingest', async () => {
    const counts = await ingestNangoRecords(githubFixtures, { tenantId })
    expect(counts.added).toBe(githubFixtures.length)
    expect(counts.updated).toBe(0)
    expect(counts.failed).toBe(0)
    expect(await Event.countDocuments({ tenantId })).toBe(githubFixtures.length)
  })

  it('is a no-op on a second identical ingest (the idempotency proof)', async () => {
    await ingestNangoRecords(githubFixtures, { tenantId })
    const second = await ingestNangoRecords(githubFixtures, { tenantId })
    expect(second.added).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.unchanged).toBe(githubFixtures.length)
    expect(await Event.countDocuments({ tenantId })).toBe(githubFixtures.length)
  })

  it('counts an unmappable record as failed without throwing', async () => {
    const counts = await ingestNangoRecords(
      [...githubFixtures, { _nango_metadata: { model: 'GithubGist' } }],
      { tenantId }
    )
    expect(counts.failed).toBe(1)
    expect(counts.added).toBe(githubFixtures.length)
  })
})

describe('idempotent upsert', () => {
  it('adds a new event', async () => {
    expect((await ingestEvent(issueEvent(), { tenantId })).status).toBe('added')
    expect(await Event.countDocuments({ tenantId })).toBe(1)
  })

  it('treats an exact re-ingest (same version) as unchanged', async () => {
    await ingestEvent(issueEvent(), { tenantId })
    expect((await ingestEvent(issueEvent(), { tenantId })).status).toBe('unchanged')
    expect(await Event.countDocuments({ tenantId })).toBe(1)
  })

  it('requires a tenantId', async () => {
    await expect(ingestEvent(issueEvent(), {})).rejects.toThrow(/tenantId/i)
  })
})

describe('content-hash dedup', () => {
  it('records a real change (new version + new content) as updated', async () => {
    await ingestEvent(issueEvent({ version: 'v1', title: 'Login broken' }), { tenantId })
    const res = await ingestEvent(issueEvent({ version: 'v2', title: 'Login broken on Safari' }), { tenantId })
    expect(res.status).toBe('updated')
    // append-per-version: the entity now has two history rows
    expect(await Event.countDocuments({ tenantId, externalId: 'issue:42' })).toBe(2)
  })

  it('suppresses a spurious version bump with identical content as unchanged', async () => {
    await ingestEvent(issueEvent({ version: 'v1', title: 'Login broken' }), { tenantId })
    const res = await ingestEvent(issueEvent({ version: 'v2', title: 'Login broken' }), { tenantId })
    expect(res.status).toBe('unchanged')
    expect(await Event.countDocuments({ tenantId, externalId: 'issue:42' })).toBe(1)
  })
})

describe('tenant isolation', () => {
  it('keeps the same external record separate per tenant', async () => {
    const tenantB = new mongoose.Types.ObjectId()
    expect((await ingestEvent(issueEvent(), { tenantId })).status).toBe('added')
    expect((await ingestEvent(issueEvent(), { tenantId: tenantB })).status).toBe('added')
    expect(await Event.countDocuments({ externalId: 'issue:42' })).toBe(2)
    expect(await Event.countDocuments({ tenantId })).toBe(1)
    expect(await Event.countDocuments({ tenantId: tenantB })).toBe(1)
  })
})
