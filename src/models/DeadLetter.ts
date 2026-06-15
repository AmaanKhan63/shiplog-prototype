import mongoose, { type Model, type HydratedDocument, type Types } from 'mongoose'
import type { IngestJobData } from '../queue/types.js'

const { Schema } = mongoose

export interface IDeadLetter {
  tenantId: Types.ObjectId
  connectionId?: Types.ObjectId
  syncRunId?: Types.ObjectId
  payload?: IngestJobData
  errorMessage?: string
  errorStack?: string
  attemptsMade?: number
  failedAt?: Date
  replayedAt?: Date
  createdAt?: Date
  updatedAt?: Date
}

// DLQ record — full context for a processing failure, kept for replay
// (Milestones 2/3). "An alert, not an archive."
const deadLetterSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    connectionId: { type: Schema.Types.ObjectId, ref: 'Connection' },
    syncRunId: { type: Schema.Types.ObjectId, ref: 'SyncRun' },
    payload: { type: Schema.Types.Mixed },
    errorMessage: { type: String },
    errorStack: { type: String },
    attemptsMade: { type: Number },
    failedAt: { type: Date, default: Date.now },
    replayedAt: { type: Date },
  },
  { timestamps: true }
)

deadLetterSchema.index({ tenantId: 1, failedAt: -1 })

export type DeadLetterDoc = HydratedDocument<IDeadLetter>
export const DeadLetter: Model<IDeadLetter> =
  mongoose.models.DeadLetter || mongoose.model<IDeadLetter>('DeadLetter', deadLetterSchema)
