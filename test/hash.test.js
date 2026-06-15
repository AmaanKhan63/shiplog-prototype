import { describe, it, expect } from 'vitest'
import { idempotencyKey, contentHash, canonicalize } from '../src/events/hash.js'

describe('idempotencyKey', () => {
  const base = { tenantId: 't1', source: 'github', externalId: 'issue:5', version: '2024-01-01T00:00:00Z' }

  it('is deterministic for identical inputs', () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }))
  })

  it('is a 64-char hex sha256', () => {
    expect(idempotencyKey(base)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('changes when the version changes (so a new source version is a distinct row)', () => {
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, version: '2024-02-02T00:00:00Z' }))
  })

  it('changes when the tenant changes (tenant isolation in the key)', () => {
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, tenantId: 't2' }))
  })

  it('changes when the externalId changes', () => {
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, externalId: 'issue:6' }))
  })

  it('coerces tenantId to a stable string (ObjectId-like and string forms match)', () => {
    const asString = idempotencyKey({ ...base, tenantId: '507f1f77bcf86cd799439011' })
    const asObj = idempotencyKey({ ...base, tenantId: { toString: () => '507f1f77bcf86cd799439011' } })
    expect(asString).toBe(asObj)
  })
})

describe('contentHash', () => {
  const content = { source: 'github', type: 'issue', externalId: 'issue:5', actor: 'octocat', title: 'Fix bug', url: 'https://x/1', occurredAt: '2024-01-01T00:00:00.000Z' }

  it('is independent of key ordering', () => {
    const reordered = { url: 'https://x/1', title: 'Fix bug', occurredAt: '2024-01-01T00:00:00.000Z', externalId: 'issue:5', type: 'issue', actor: 'octocat', source: 'github' }
    expect(contentHash(content)).toBe(contentHash(reordered))
  })

  it('changes when semantic content changes (drives "updated" vs "unchanged")', () => {
    expect(contentHash(content)).not.toBe(contentHash({ ...content, title: 'Fix other bug' }))
  })

  it('treats equal Date and ISO string as the same content', () => {
    const withDate = { ...content, occurredAt: new Date('2024-01-01T00:00:00.000Z') }
    expect(contentHash(withDate)).toBe(contentHash(content))
  })
})

describe('canonicalize', () => {
  it('sorts object keys recursively and serializes Dates as ISO', () => {
    const out = canonicalize({ b: 2, a: { d: new Date('2024-01-01T00:00:00.000Z'), c: 1 } })
    expect(JSON.stringify(out)).toBe('{"a":{"c":1,"d":"2024-01-01T00:00:00.000Z"},"b":2}')
  })
})
