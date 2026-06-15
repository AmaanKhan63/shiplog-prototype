import mongoose from 'mongoose'

const { Schema } = mongoose

// Isolation root. Every other document carries a tenantId pointing here.
const tenantSchema = new Schema(
  {
    name: { type: String, required: true },
    apiKey: { type: String, required: true, unique: true },
  },
  { timestamps: true }
)

export const Tenant = mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema)
