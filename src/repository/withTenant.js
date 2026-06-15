import { Event } from '../models/index.js'

/**
 * Tenant-scoped repository wrapper — the application-level analog of Postgres
 * row-level security. Every query made through it is forced to carry the
 * tenantId filter, so a handler physically cannot read another tenant's rows.
 *
 * Minimal for Milestones 0/1 (just the events spine). The full multi-collection
 * wrapper + the negative isolation test land in Milestone 7.
 */
export function withTenant(tenantId) {
  if (!tenantId) throw new Error('withTenant requires a tenantId')

  return {
    events: {
      find: (filter = {}) => Event.find({ ...filter, tenantId }),
      findOne: (filter = {}) => Event.findOne({ ...filter, tenantId }),
      countDocuments: (filter = {}) => Event.countDocuments({ ...filter, tenantId }),
    },
  }
}
