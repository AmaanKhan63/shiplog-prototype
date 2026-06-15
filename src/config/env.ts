import 'dotenv/config'

export const config = {
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/shiplog-sync',
  port: Number(process.env.PORT) || 3000,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // Base delay for the exponential backoff (ms); jitter is added on top.
  backoffBaseMs: Number(process.env.BACKOFF_BASE_MS) || 1000,
  // How often the reconciliation sweep polls Nango (ms). Default 60s.
  reconcileEveryMs: Number(process.env.RECONCILE_EVERY_MS) || 60000,

  // Nango (Milestone 4)
  nangoSecretKey: process.env.NANGO_SECRET_KEY || '',
  nangoWebhookSecret: process.env.NANGO_WEBHOOK_SECRET || '', // Environment Settings > Webhooks > Signing key
  nangoHost: process.env.NANGO_HOST || 'https://api.nango.dev',
  // Use static fixtures in place of real Nango when no secret key is set (local
  // verification without a Nango account).
  nangoUseFixtures: process.env.NANGO_USE_FIXTURES === 'true' || !process.env.NANGO_SECRET_KEY,
  nangoDebug: process.env.NANGO_DEBUG === 'true',
}
