import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyNangoSignature, computeNangoHmac } from '../src/nango/verify.js'

// NOTE: this proves the verifier matches the *documented* scheme (HMAC-SHA256 over
// the raw body, X-Nango-Hmac-Sha256, signing key). It is self-consistent by
// construction — it is NOT validation against a live Nango webhook.
const SECRET = 'whsec_test_123'
const body = Buffer.from(JSON.stringify({ type: 'sync', connectionId: 'c1', model: 'GithubIssue' }))
const goodSig = createHmac('sha256', SECRET).update(body).digest('hex')

describe('verifyNangoSignature', () => {
  it('accepts a correct X-Nango-Hmac-Sha256 over the raw body', () => {
    expect(verifyNangoSignature(body, { 'x-nango-hmac-sha256': goodSig }, SECRET)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(body.toString().replace('GithubIssue', 'GithubPullRequest'))
    expect(verifyNangoSignature(tampered, { 'x-nango-hmac-sha256': goodSig }, SECRET)).toBe(false)
  })

  it('rejects a wrong-VALUE signature of the right length', () => {
    const wrong = 'f'.repeat(goodSig.length)
    expect(verifyNangoSignature(body, { 'x-nango-hmac-sha256': wrong }, SECRET)).toBe(false)
  })

  it('rejects a wrong-LENGTH signature without throwing (timingSafeEqual guard)', () => {
    expect(() => verifyNangoSignature(body, { 'x-nango-hmac-sha256': 'abcd' }, SECRET)).not.toThrow()
    expect(verifyNangoSignature(body, { 'x-nango-hmac-sha256': 'abcd' }, SECRET)).toBe(false)
  })

  it('rejects a missing signature header', () => {
    expect(verifyNangoSignature(body, {}, SECRET)).toBe(false)
  })

  it('rejects when no signing key is configured', () => {
    expect(verifyNangoSignature(body, { 'x-nango-hmac-sha256': goodSig }, '')).toBe(false)
  })

  it('reads the header case-insensitively', () => {
    expect(verifyNangoSignature(body, { 'X-Nango-Hmac-Sha256': goodSig }, SECRET)).toBe(true)
  })
})

describe('computeNangoHmac (for debug logging)', () => {
  it('returns the hex HMAC of the body', () => {
    expect(computeNangoHmac(body, SECRET)).toBe(goodSig)
  })
})
