import mongoose from 'mongoose'

const TEST_URI = process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/shiplog-sync-test'

export async function connectTestDB() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(TEST_URI)
  }
  return mongoose.connection
}

/** Wipe all documents between tests without tearing down indexes. */
export async function clearDB() {
  const { collections } = mongoose.connection
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})))
}

/** Drop the whole test database and disconnect (final teardown). */
export async function dropAndClose() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  }
}
