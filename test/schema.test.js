import { describe, it, expect } from 'vitest'
import { NormalizedEventSchema } from '../src/events/schema.js'

const valid = {
  source: 'github', type: 'issue', externalId: 'issue:5', actor: 'octocat',
  title: 'Fix bug', url: 'https://github.com/x/1', occurredAt: '2024-01-01T00:00:00Z', version: '2024-01-02T00:00:00Z',
}

describe('NormalizedEventSchema', () => {
  it('accepts a well-formed normalized event', () => {
    expect(() => NormalizedEventSchema.parse(valid)).not.toThrow()
  })

  it('coerces occurredAt (ISO string) to a Date', () => {
    const parsed = NormalizedEventSchema.parse(valid)
    expect(parsed.occurredAt).toBeInstanceOf(Date)
  })

  it('rejects an unknown event type', () => {
    expect(() => NormalizedEventSchema.parse({ ...valid, type: 'gist' })).toThrow()
  })

  it('rejects a non-URL url', () => {
    expect(() => NormalizedEventSchema.parse({ ...valid, url: 'not a url' })).toThrow()
  })

  it('rejects a missing actor', () => {
    const { actor, ...withoutActor } = valid
    expect(() => NormalizedEventSchema.parse(withoutActor)).toThrow()
  })
})
