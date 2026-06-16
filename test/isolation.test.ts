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
 * Models the demo scenario: two tenants (Acme, Globex) share ONE Nango
 * connection, so BOTH hold the *same* records (identical externalIds), each
 * stamped with its own tenantId. Isolation must keep them apart despite the
 * content being identical.
 *
 * The test is deliberately non-vacuous — both tenants have data — so it proves
 * scoping, not emptiness. Each assertion FAILS if the `tenantId` filter is ever
 * dropped from `withTenant`: with the filter gone, a tenant's `find({})` would
 * return BOTH tenants' rows (double the count), so the exact-count assertions
 * below would break.
 */
let tenantA: TenantDoc, tenantB: TenantDoc
let perTenant: number

beforeAll(async () => {
  await connectTestDB()
  await Event.syncIndexes()
})
afterAll(dropAndClose)
beforeEach(async () => {
  await clearDB()
  tenantA = await Tenant.create({ name: 'Acme', apiKey: 'acme-api-key' })
  tenantB = await Tenant.create({ name: 'Globex', apiKey: 'globex-api-key' })
  // BOTH tenants ingest the SAME real-shaped records (same externalIds). The
  // tenantId in the idempotency key keeps them as distinct rows per tenant —
  // exactly what two tenants sharing one Nango connection produce.
  for (const record of githubFixtures) {
    const normalized = normalizeGithubRecord(record)
    await ingestEvent(normalized, { tenantId: tenantA._id })
    await ingestEvent(normalized, { tenantId: tenantB._id })
  }
  perTenant = await Event.countDocuments({ tenantId: tenantA._id })
})

describe('multi-tenant isolation (negative test, both tenants have data)', () => {
  it('precondition: both tenants hold the same number of rows, and there is more data than any one tenant', async () => {
    expect(perTenant).toBeGreaterThan(0)
    expect(await Event.countDocuments({ tenantId: tenantB._id })).toBe(perTenant)
    // The DB holds both tenants' rows — so a scoped read returning only `perTenant`
    // is a real filter, not "there was only ever one tenant's data."
    expect(await Event.countDocuments({})).toBe(perTenant * 2)
  })

  it("Acme's repository wrapper returns only Acme's rows — and fails if the tenantId filter is dropped", async () => {
    // Deliberately UNfiltered query through Acme's wrapper. If `withTenant`
    // stopped injecting `tenantId`, this would return BOTH tenants' rows
    // (perTenant * 2) and the assertions would fail — the guarantee the wrapper exists for.
    const visibleToA = await withTenant(tenantA._id).events.find({}).lean()
    expect(visibleToA).toHaveLength(perTenant)
    expect(visibleToA.every((e) => String(e.tenantId) === String(tenantA._id))).toBe(true)
    // Symmetric: Globex's wrapper returns only Globex's rows.
    const visibleToB = await withTenant(tenantB._id).events.find({}).lean()
    expect(visibleToB).toHaveLength(perTenant)
    expect(visibleToB.every((e) => String(e.tenantId) === String(tenantB._id))).toBe(true)
  })

  it("does not leak Globex's row to Acme even when querying a shared externalId", async () => {
    const shared = await Event.findOne({ tenantId: tenantB._id }).lean()
    const seenByA = await withTenant(tenantA._id).events.find({ externalId: shared!.externalId }).lean()
    // Both tenants have this externalId, but Acme sees only its own copy.
    expect(seenByA).toHaveLength(1)
    expect(String(seenByA[0]!.tenantId)).toBe(String(tenantA._id))
  })

  it("each tenant's API key reads only its own events via GET /events", async () => {
    const app = buildApp()

    const resA = await request(app).get('/events').set('Authorization', 'Bearer acme-api-key')
    expect(resA.status).toBe(200)
    expect(resA.body.count).toBe(perTenant)
    expect(resA.body.events.every((e: { tenantId: string }) => String(e.tenantId) === String(tenantA._id))).toBe(true)

    const resB = await request(app).get('/events').set('Authorization', 'Bearer globex-api-key')
    expect(resB.status).toBe(200)
    expect(resB.body.count).toBe(perTenant)
    expect(resB.body.events.every((e: { tenantId: string }) => String(e.tenantId) === String(tenantB._id))).toBe(true)
  })
})
