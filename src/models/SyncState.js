import mongoose from 'mongoose'

const { Schema } = mongoose

// Reconciliation cursor against Nango's records API (advances only after a
// durable upsert — Milestone 5). The cursor is per-model: Nango paginates each
// model independently, so a connection has one cursor row per model it syncs.
const syncStateSchema = new Schema(
  {
    connectionId: { type: Schema.Types.ObjectId, ref: 'Connection', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    model: { type: String, required: true },
    cursor: { type: String },
    lastSyncAt: { type: Date },
    mode: { type: String, enum: ['full', 'incremental'], default: 'incremental' },
  },
  { timestamps: true }
)

syncStateSchema.index({ tenantId: 1, connectionId: 1, model: 1 }, { unique: true })

export const SyncState = mongoose.models.SyncState || mongoose.model('SyncState', syncStateSchema)
