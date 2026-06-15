import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verify an incoming Nango webhook signature.
 *
 * Implements the documented secure scheme: HMAC-SHA256 over the **raw request
 * body**, compared against the `X-Nango-Hmac-Sha256` header, keyed by the webhook
 * signing key (Nango dashboard > Environment Settings > Webhooks > Signing key).
 * Constant-time compare via timingSafeEqual.
 *
 * IMPORTANT: this matches Nango's documented scheme but has not been validated
 * against a live webhook. If real webhooks 401, log the computed-vs-received
 * (NANGO_DEBUG) and fall back to the SDK's `nango.verifyIncomingWebhookRequest`.
 */
export function computeNangoHmac(rawBody, signingKey) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? '', 'utf8')
  return createHmac('sha256', signingKey).update(body).digest('hex')
}

function headerValue(headers, name) {
  if (!headers) return undefined
  const target = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key]
  }
  return undefined
}

// Length-guarded constant-time hex compare. timingSafeEqual throws if the buffers
// differ in length, which a forged/truncated signature will — guard first.
function safeHexEqual(aHex, bHex) {
  if (typeof aHex !== 'string' || typeof bHex !== 'string') return false
  const a = Buffer.from(aHex, 'hex')
  const b = Buffer.from(bHex, 'hex')
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function verifyNangoSignature(rawBody, headers, signingKey) {
  if (!signingKey) return false
  const received = headerValue(headers, 'x-nango-hmac-sha256')
  if (!received) return false
  return safeHexEqual(computeNangoHmac(rawBody, signingKey), received)
}
