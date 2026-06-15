import mongoose from 'mongoose'

const { Schema } = mongoose

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

export const Connection = mongoose.models.Connection || mongoose.model('Connection', connectionSchema)
