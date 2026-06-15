import { Tenant } from '../models/index.js'

/** Pull the API key from `Authorization: Bearer <key>` or `x-api-key`. */
function extractApiKey(req) {
  const auth = req.get('authorization')
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim()
  const headerKey = req.get('x-api-key')
  return headerKey ? headerKey.trim() : null
}

/**
 * Every protected route requires a tenant API key, resolved to a tenant and
 * injected onto the request. Downstream handlers must scope every query through
 * `req.tenantId` (via the withTenant repository wrapper) — application-level
 * RLS, since Mongo has no engine-level row security.
 */
export async function tenantAuth(req, res, next) {
  try {
    const apiKey = extractApiKey(req)
    if (!apiKey) return res.status(401).json({ error: 'Missing API key' })

    const tenant = await Tenant.findOne({ apiKey })
    if (!tenant) return res.status(401).json({ error: 'Invalid API key' })

    req.tenant = tenant
    req.tenantId = tenant._id
    next()
  } catch (err) {
    next(err)
  }
}
