import mongoose, { type Model, type HydratedDocument, type Types } from 'mongoose'

const { Schema } = mongoose

export interface IConnection {
  tenantId: Types.ObjectId
  provider: string
  nangoConnectionId?: string | null
  nangoIntegrationId?: string | null
  status: string
  models: string[]
  createdAt?: Date
  updatedAt?: Date
}

// Maps a Nango connection to a Shiplog tenant.
const connectionSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    provider: { type: String, default: 'github' },
    nangoConnectionId: { type: String },
    nangoIntegrationId: { type: String },
    status: { type: String, default: 'active' },
    // Nango models this connection syncs — what the reconciliation poller pulls.
    models: { type: [String], default: ['GithubIssue'] },
  },
  { timestamps: true }
)

connectionSchema.index({ tenantId: 1 })

export type ConnectionDoc = HydratedDocument<IConnection>
export const Connection: Model<IConnection> =
  mongoose.models.Connection || mongoose.model<IConnection>('Connection', connectionSchema)
