import type { RedisOptions } from 'ioredis'
import { config } from '../config/env.js'

/**
 * BullMQ connection options (ioredis under the hood).
 *
 * We pass *options* (not a shared IORedis instance) to each Queue/Worker so that
 * BullMQ owns the connection lifecycle: `worker.close()` / `queue.close()` drains
 * the blocking commands and closes the socket cleanly. Sharing one instance and
 * closing it externally races BullMQ's blocking loop and can surface an unhandled
 * rejection on teardown.
 *
 *   - maxRetriesPerRequest: null  → required by BullMQ
 *   - enableReadyCheck: false     → Upstash compatibility
 *   - tls (for rediss://)         → Upstash TLS
 */
export function redisConnectionOptions(): RedisOptions {
  const url = new URL(config.redisUrl)
  const options: RedisOptions = {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }
  if (url.username) options.username = decodeURIComponent(url.username)
  if (url.password) options.password = decodeURIComponent(url.password)
  if (url.protocol === 'rediss:') options.tls = {}
  return options
}
