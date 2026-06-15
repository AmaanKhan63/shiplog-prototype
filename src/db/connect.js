import mongoose from 'mongoose'

export async function connectDB(uri) {
  await mongoose.connect(uri)
  return mongoose.connection
}

export async function disconnectDB() {
  await mongoose.disconnect()
}
