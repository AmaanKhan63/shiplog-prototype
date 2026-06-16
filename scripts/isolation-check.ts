/**
 * Live multi-tenant isolation check (read-only) for the on-camera demo.
 *
 *   npm run isolation-check
 *
 * The vitest `isolation.test.ts` proves the guarantee on fixtures in a test DB;
 * this asserts the SAME property against the real synced data in the dev DB, so
 * you can show a PASS on the actual Acme/Globex rows. It mutates nothing.
 *
 * Prerequisite: both tenants exist and are populated —
 *   npm run setup-tenants <nangoConnectionId> github
 *   curl -X POST .../connections/<acmeConnId>/reconcile   -H "Authorization: Bearer acme-api-key"
 *   curl -X POST .../connections/<globexConnId>/reconcile -H "Authorization: Bearer globex-api-key"
 *
 * Asserts, through the `withTenant` wrapper (the app-level RLS the API uses):
 *   - both tenants hold data (non-vacuous — not "isolation by emptiness"),
 *   - each tenant's scoped query returns ONLY its own rows,
 *   - a shared externalId resolves to each tenant's own copy, never the other's.
 */
import { config } from '../src/config/env.js'
import { connectDB, disconnectDB } from '../src/db/connect.js'
import { Tenant } from '../src/models/index.js'
import { withTenant } from '../src/repository/withTenant.js'

const KEYS = { acme: 'acme-api-key', globex: 'globex-api-key' }

async function main() {
  await connectDB(config.mongoUri)

  const acme = await Tenant.findOne({ apiKey: KEYS.acme })
  const globex = await Tenant.findOne({ apiKey: KEYS.globex })
  if (!acme || !globex) {
    console.error('Acme/Globex tenants not found. Run `npm run setup-tenants <nangoConnectionId> github` first.')
    await disconnectDB()
    process.exit(2)
  }

  const aRows = await withTenant(acme._id).events.find({}).lean()
  const bRows = await withTenant(globex._id).events.find({}).lean()

  const aOnlyAcme = aRows.every((e) => String(e.tenantId) === String(acme._id))
  const bOnlyGlobex = bRows.every((e) => String(e.tenantId) === String(globex._id))
  const bleed =
    aRows.some((e) => String(e.tenantId) === String(globex._id)) ||
    bRows.some((e) => String(e.tenantId) === String(acme._id))

  // A shared externalId (same commit synced into both) must resolve per-tenant.
  let sharedOk = true
  let sharedExternalId: string | undefined
  if (bRows.length) {
    sharedExternalId = bRows[0]!.externalId
    const seenByAcme = await withTenant(acme._id).events.find({ externalId: sharedExternalId }).lean()
    sharedOk = seenByAcme.every((e) => String(e.tenantId) === String(acme._id))
  }

  const nonVacuous = aRows.length > 0 && bRows.length > 0
  const pass = nonVacuous && aOnlyAcme && bOnlyGlobex && !bleed && sharedOk

  console.log('')
  console.log(`Acme   (${acme._id})   events = ${aRows.length}   all stamped Acme:   ${aOnlyAcme}`)
  console.log(`Globex (${globex._id})   events = ${bRows.length}   all stamped Globex: ${bOnlyGlobex}`)
  if (sharedExternalId) console.log(`Shared externalId "${sharedExternalId}" → Acme sees only its own copy: ${sharedOk}`)
  console.log(`Cross-tenant bleed: ${bleed ? 'DETECTED' : 'none'}`)
  console.log('')
  console.log(
    pass
      ? '✓ ISOLATION OK — both tenants populated, each scoped query returns only its own rows, nothing leaks.'
      : `✗ ISOLATION FAIL — ${!nonVacuous ? 'a tenant has no data (reconcile both first); ' : ''}${bleed ? 'cross-tenant bleed; ' : ''}${!sharedOk ? 'shared-id leak; ' : ''}check withTenant.`
  )

  await disconnectDB()
  process.exit(pass ? 0 : 1)
}

main().catch((err) => { console.error(err); process.exit(1) })
