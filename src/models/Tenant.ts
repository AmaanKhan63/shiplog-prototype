import mongoose, { type Model, type HydratedDocument } from 'mongoose'

const { Schema } = mongoose

export interface ITenant {
  name: string
  apiKey: string
  createdAt?: Date
  updatedAt?: Date
}

// Isolation root. Every other document carries a tenantId pointing here.
const tenantSchema = new Schema(
  {
    name: { type: String, required: true },
    apiKey: { type: String, required: true, unique: true },
  },
  { timestamps: true }
)

export type TenantDoc = HydratedDocument<ITenant>
export const Tenant: Model<ITenant> = mongoose.models.Tenant || mongoose.model<ITenant>('Tenant', tenantSchema)
