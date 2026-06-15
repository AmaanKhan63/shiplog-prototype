import mongoose, { type Types } from 'mongoose'
import { Event } from '../models/index.js'
import type { IEvent } from '../models/Event.js'

/**
 * Tenant-scoped repository wrapper — the application-level analog of Postgres
 * row-level security. Every query made through it is forced to carry the
 * tenantId filter, so a handler physically cannot read another tenant's rows.
 *
 * Minimal for Milestones 0/1 (just the events spine). The full multi-collection
 * wrapper + the negative isolation test land in Milestone 7.
 */
export function withTenant(tenantId: Types.ObjectId | string) {
  if (!tenantId) throw new Error('withTenant requires a tenantId')

  return {
    events: {
      find: (filter: mongoose.QueryFilter<IEvent> = {}) => Event.find({ ...filter, tenantId }),
      findOne: (filter: mongoose.QueryFilter<IEvent> = {}) => Event.findOne({ ...filter, tenantId }),
      countDocuments: (filter: mongoose.QueryFilter<IEvent> = {}) => Event.countDocuments({ ...filter, tenantId }),
    },
  }
}
