import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import { connectTestDB, clearDB, dropAndClose } from './helpers/db.js'
import { buildApp } from '../src/app.js'
import { withTenant } from '../src/repository/withTenant.js'
import { Tenant, Event } from '../src/models/index.js'
import { ingestEvent } from '../src/events/ingest.js'
import { normalizeGithubRecord } from '../src/normalize/github.js'
import { githubFixtures } from '../src/fixtures/github.js'
import type { TenantDoc } from '../src/models/Tenant.js'

/**
 * Negative multi-tenant isolation test (spec §C / §E step 7).
 *
 * Proves Tenant B cannot read Tenant A's events — both through the `withTenant`
 * repository wrapper (the app-level RLS analog) and through the tenant-scoped
 * `GET /events` API. The repository assertion is written so it FAILS if the
 * `tenantId` filter is ever dropped from `withTenant`: with the filter gone,
 * `withTenant(B).events.find({})` would return all of A's rows.
 */
let tenantA: TenantDoc, tenantB: TenantDoc

beforeAll(async () => {
  await connectTestDB()
  await Event.syncIndexes()
})
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantA = await Tenant.create({ name: 'Acme', apiKey: 'key-a' })
  tenantB = await Tenant.create({ name: 'Globex', apiKey: 'key-b' })
  // Only Tenant A has events; Tenant B has none.
  for (const record of githubFixtures) await ingestEvent(normalizeGithubRecord(record), { tenantId: tenantA._id })
})

describe('multi-tenant isolation (negative test)', () => {
  it("hides Tenant A's events from Tenant B's repository wrapper — and fails if the tenantId filter is dropped", async () => {
    const aTotal = await Event.countDocuments({ tenantId: tenantA._id })
    expect(aTotal).toBeGreaterThan(0) // precondition: A actually has data

    // Tenant B's wrapper, even with a deliberately UNfiltered query, must see none
    // of A's rows. If `withTenant` stopped injecting `tenantId`, this `find({})`
    // would return all of A's events and this length assertion would fail — which
    // is exactly the guarantee the wrapper exists to provide.
    const visibleToB = await withTenant(tenantB._id).events.find({}).lean()
    expect(visibleToB).toHaveLength(0)

    // Anti-vacuous control: A's own wrapper DOES return A's rows, so isolation is
    // real scoping — not "the wrapper returns nothing for everyone."
    const visibleToA = await withTenant(tenantA._id).events.find({}).lean()
    expect(visibleToA).toHaveLength(aTotal)
  })

  it("does not leak A's events to B even when B queries A's exact externalId", async () => {
    const anAEvent = await Event.findOne({ tenantId: tenantA._id }).lean()
    const leaked = await withTenant(tenantB._id).events.find({ externalId: anAEvent!.externalId }).lean()
    expect(leaked).toHaveLength(0)
  })

  it("Tenant B's API key cannot read Tenant A's events via GET /events", async () => {
    const app = buildApp()

    const resB = await request(app).get('/events').set('Authorization', 'Bearer key-b')
    expect(resB.status).toBe(200)
    expect(resB.body.count).toBe(0)
    expect(resB.body.events).toEqual([])

    // ...while Tenant A reads its own events through the very same endpoint.
    const resA = await request(app).get('/events').set('Authorization', 'Bearer key-a')
    expect(resA.status).toBe(200)
    expect(resA.body.count).toBeGreaterThan(0)
  })
})
