import 'dotenv/config'

export const config = {
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/shiplog-sync',
  port: Number(process.env.PORT) || 3000,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // Base delay for the exponential backoff (ms); jitter is added on top.
  backoffBaseMs: Number(process.env.BACKOFF_BASE_MS) || 1000,
}
