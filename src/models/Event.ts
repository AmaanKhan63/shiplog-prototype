import mongoose, { type Model, type HydratedDocument, type Types } from 'mongoose'
import type { EventTypeName } from '../events/schema.js'

const { Schema } = mongoose

export interface IEvent {
  tenantId: Types.ObjectId
  idempotencyKey: string
  type: EventTypeName
  source: string
  externalId: string
  contentHash: string
  actor?: string
  title?: string
  url?: string
  occurredAt: Date
  version: string
  deleted: boolean
  createdAt?: Date
  updatedAt?: Date
}

// The unified, deduped, tenant-scoped event spine the product/agent consumes.
//
// Identity & dedup:
//   idempotencyKey = hash(tenantId + source + externalId + version) — UNIQUE.
//     Re-ingesting the same source version is a no-op against this index;
//     a new version lands as a distinct row (append-per-version history),
//     so replaying a stale version can never overwrite current state.
//   contentHash = hash(semantic fields, excluding version) — lets us tell a
//     real "updated" from a no-op update (e.g. a spurious updatedAt bump).
const eventSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    type: { type: String, enum: ['commit', 'issue', 'pr', 'release'], required: true },
    source: { type: String, required: true },
    externalId: { type: String, required: true },
    contentHash: { type: String, required: true },
    // normalized fields
    actor: { type: String },
    title: { type: String },
    url: { type: String },
    occurredAt: { type: Date, required: true },
    version: { type: String, required: true },
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
)

// tenantId-prefixed compound indexes (app-level isolation + query paths).
eventSchema.index({ tenantId: 1, externalId: 1 })
eventSchema.index({ tenantId: 1, occurredAt: -1 })

export type EventDoc = HydratedDocument<IEvent>
export const Event: Model<IEvent> = mongoose.models.Event || mongoose.model<IEvent>('Event', eventSchema)
