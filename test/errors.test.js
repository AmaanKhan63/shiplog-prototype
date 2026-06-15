import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { TransientError, LogicalError, classifyError, parseRetryAfter } from '../src/queue/errors.js'

describe('error classes', () => {
  it('TransientError is tagged transient and carries retry metadata', () => {
    const e = new TransientError('boom', { statusCode: 503, retryAfterMs: 2000 })
    expect(e.kind).toBe('transient')
    expect(e.statusCode).toBe(503)
    expect(e.retryAfterMs).toBe(2000)
    expect(e).toBeInstanceOf(Error)
  })

  it('LogicalError is tagged logical', () => {
    expect(new LogicalError('bad').kind).toBe('logical')
  })
})

describe('classifyError', () => {
  it('classifies an explicit TransientError as transient', () => {
    expect(classifyError(new TransientError('x', { retryAfterMs: 1500 }))).toEqual({ kind: 'transient', retryAfterMs: 1500 })
  })

  it('classifies an explicit LogicalError as logical', () => {
    expect(classifyError(new LogicalError('x')).kind).toBe('logical')
  })

  it('classifies a Zod validation error as logical (bad payload, no retry)', () => {
    let zerr
    try { z.object({ a: z.string() }).parse({ a: 1 }) } catch (e) { zerr = e }
    expect(classifyError(zerr).kind).toBe('logical')
  })

  it('classifies 5xx and 429 as transient; 429 surfaces Retry-After', () => {
    expect(classifyError({ statusCode: 500 }).kind).toBe('transient')
    expect(classifyError({ status: 502 }).kind).toBe('transient')
    expect(classifyError({ statusCode: 429, headers: { 'retry-after': '3' } })).toEqual({ kind: 'transient', retryAfterMs: 3000 })
  })

  it('classifies network errors as transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) {
      expect(classifyError({ code }).kind).toBe('transient')
    }
  })

  it('classifies a 4xx (non-429) as logical', () => {
    expect(classifyError({ statusCode: 422 }).kind).toBe('logical')
  })

  it('defaults an unknown error to logical (do not blindly retry)', () => {
    expect(classifyError(new Error('mystery')).kind).toBe('logical')
  })
})

describe('parseRetryAfter', () => {
  it('parses delay-seconds into milliseconds', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter(5)).toBe(5000)
  })

  it('returns undefined for unparseable input', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined()
    expect(parseRetryAfter('not-a-number-or-date')).toBeUndefined()
  })
})
