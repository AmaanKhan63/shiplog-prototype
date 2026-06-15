/**
 * Exponential backoff with jitter.
 *
 *   delay = base * factor^(attemptsMade-1) + random jitter (up to jitterRatio),
 *           capped at capMs.
 *
 * Jitter prevents synchronized retry storms (the "thundering herd"). If the
 * error carried a Retry-After, that wins outright. Pure and deterministic when
 * `rng` is injected — the worker passes Math.random in production.
 */
export function computeBackoff(
  attemptsMade,
  { retryAfterMs, baseMs = 1000, factor = 2, jitterRatio = 0.25, capMs = 30000, rng = Math.random } = {}
) {
  if (retryAfterMs != null) return retryAfterMs

  const exponential = baseMs * factor ** (attemptsMade - 1)
  const jitter = rng() * exponential * jitterRatio
  return Math.min(capMs, Math.floor(exponential + jitter))
}
