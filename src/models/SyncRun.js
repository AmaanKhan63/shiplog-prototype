import mongoose from 'mongoose'

const { Schema } = mongoose

// Observability: one document per sync run with normalized counts, duration,
// status and what triggered it.
const countsSchema = new Schema(
  {
    added: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    deleted: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
  },
  { _id: false }
)

const syncRunSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    connectionId: { type: Schema.Types.ObjectId, ref: 'Connection' },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
    status: { type: String, enum: ['running', 'success', 'failed'], default: 'running' },
    counts: { type: countsSchema, default: () => ({}) },
    trigger: { type: String, enum: ['webhook', 'reconcile', 'backfill'], required: true },
  },
  { timestamps: true }
)

syncRunSchema.index({ tenantId: 1, createdAt: -1 })

export const SyncRun = mongoose.models.SyncRun || mongoose.model('SyncRun', syncRunSchema)
