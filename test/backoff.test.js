import { describe, it, expect } from 'vitest'
import { computeBackoff } from '../src/queue/backoff.js'

const noJitter = () => 0
const maxJitter = () => 0.999999

describe('computeBackoff', () => {
  it('grows exponentially: 1s, 2s, 4s, 8s (base 1000, no jitter)', () => {
    expect(computeBackoff(1, { rng: noJitter })).toBe(1000)
    expect(computeBackoff(2, { rng: noJitter })).toBe(2000)
    expect(computeBackoff(3, { rng: noJitter })).toBe(4000)
    expect(computeBackoff(4, { rng: noJitter })).toBe(8000)
  })

  it('adds jitter on top of the exponential base, bounded by jitterRatio', () => {
    const base = computeBackoff(1, { rng: noJitter })
    const jittered = computeBackoff(1, { rng: maxJitter, jitterRatio: 0.25 })
    expect(jittered).toBeGreaterThan(base)
    expect(jittered).toBeLessThanOrEqual(base * 1.25)
  })

  it('honors Retry-After, ignoring the exponential schedule', () => {
    expect(computeBackoff(3, { retryAfterMs: 5000, rng: maxJitter })).toBe(5000)
  })

  it('caps the delay at capMs', () => {
    expect(computeBackoff(20, { rng: maxJitter, capMs: 30000 })).toBe(30000)
  })

  it('respects a custom baseMs (used to keep tests fast)', () => {
    expect(computeBackoff(3, { baseMs: 10, rng: noJitter })).toBe(40)
  })
})
