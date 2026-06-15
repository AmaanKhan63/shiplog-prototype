import mongoose from 'mongoose'

const { Schema } = mongoose

// Reconciliation cursor against Nango's records API (advances only after a
// durable upsert — Milestone 5).
const syncStateSchema = new Schema(
  {
    connectionId: { type: Schema.Types.ObjectId, ref: 'Connection', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    cursor: { type: String },
    lastSyncAt: { type: Date },
    mode: { type: String, enum: ['full', 'incremental'], default: 'incremental' },
  },
  { timestamps: true }
)

syncStateSchema.index({ connectionId: 1 })

export const SyncState = mongoose.models.SyncState || mongoose.model('SyncState', syncStateSchema)
