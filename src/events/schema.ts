import { z } from 'zod'

export const EventType = z.enum(['commit', 'issue', 'pr', 'release'])

/**
 * The typed, connector-agnostic event contract. A normalizer maps any source's
 * records into this shape; ingest validates against it before hashing/upserting.
 *
 *  - occurredAt: when the thing happened (coerced to a Date)
 *  - version:    change token that feeds the idempotency key (kept as a string)
 */
export const NormalizedEventSchema = z.object({
  source: z.string().min(1),
  type: EventType,
  externalId: z.string().min(1),
  actor: z.string().min(1),
  title: z.string(),
  url: z.url(),
  occurredAt: z.coerce.date(),
  version: z.union([z.string(), z.number()]).transform((v) => String(v)),
})

// One source of truth: types are derived from the Zod schema so runtime
// validation and the static types can never drift.
//   - NormalizedEventInput: what a normalizer produces (pre-parse; version may
//     be a number, occurredAt may be a string/Date — the schema coerces).
//   - NormalizedEvent: the parsed, validated shape (version: string, occurredAt: Date).
export type EventTypeName = z.infer<typeof EventType>
export type NormalizedEventInput = z.input<typeof NormalizedEventSchema>
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>
