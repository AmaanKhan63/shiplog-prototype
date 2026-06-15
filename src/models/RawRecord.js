import mongoose from 'mongoose'

const { Schema } = mongoose

// Immutable raw layer / replay source — exactly what Nango handed us, before
// normalization. Written by the webhook receiver and reconciliation poller
// (Milestones 2/4/5).
const rawRecordSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    connectionId: { type: Schema.Types.ObjectId, ref: 'Connection' },
    source: { type: String, required: true },
    externalId: { type: String, required: true },
    nangoRecordId: { type: String },
    payload: { type: Schema.Types.Mixed },
    receivedAt: { type: Date, default: Date.now },
    via: { type: String, enum: ['webhook', 'reconcile'] },
  },
  { timestamps: true }
)

rawRecordSchema.index({ tenantId: 1, externalId: 1 })

export const RawRecord = mongoose.models.RawRecord || mongoose.model('RawRecord', rawRecordSchema)
