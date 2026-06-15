import type { Types } from 'mongoose'
import type { TenantDoc } from '../models/Tenant.js'

// tenantAuth resolves the API key to a tenant and injects it onto the request;
// every protected handler scopes its queries through req.tenantId.
declare global {
  namespace Express {
    interface Request {
      tenant?: TenantDoc
      tenantId?: Types.ObjectId
    }
  }
}

export {}
