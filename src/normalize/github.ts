import type { NangoRecord } from '../nango/types.js'
import type { NormalizedEventInput } from '../events/schema.js'

/**
 * Map a Nango-shaped GitHub record into the connector-agnostic normalized event
 * contract `{ source, type, externalId, actor, title, url, occurredAt, version }`.
 *
 * Keeping the normalizer separate and per-source is what lets us say "adding
 * Jira/Linear is a new mapper into the same event spine, not a rewrite."
 *
 *  - occurredAt: when the thing actually happened (issue/PR created, commit authored)
 *  - version:    a change token that advances on every meaningful source update
 *                (updated_at for issues/PRs; the immutable sha for commits).
 *                Feeds the idempotency key.
 */
export function normalizeGithubRecord(record: NangoRecord): NormalizedEventInput {
  const model = record?._nango_metadata?.model
  // Provider fields are dynamic JSON; access them through a loose view while the
  // OUTPUT stays bound to the typed event contract.
  const r = record as Record<string, any>

  switch (model) {
    case 'GithubIssue': // fixtures use this name
    case 'Issue':       // live Nango model name
      return {
        source: 'github',
        type: 'issue',
        externalId: `issue:${r.number}`,
        actor: r.user_login ?? r.user?.login ?? 'unknown',
        title: r.title,
        url: r.html_url,
        occurredAt: new Date(r.created_at),
        version: r.updated_at,
      }

    case 'GithubPullRequest':
      return {
        source: 'github',
        type: 'pr',
        externalId: `pr:${r.number}`,
        actor: r.user?.login ?? 'unknown',
        title: r.title,
        url: r.html_url,
        occurredAt: new Date(r.created_at),
        version: r.updated_at,
      }

    case 'GithubCommit':
      return {
        source: 'github',
        type: 'commit',
        externalId: `commit:${r.sha}`,
        actor: r.author?.login ?? r.commit?.author?.name ?? 'unknown',
        title: (r.commit?.message ?? '').split('\n')[0],
        url: r.html_url,
        occurredAt: new Date(r.commit?.author?.date),
        version: r.sha,
      }

    default:
      throw new Error(`Unknown Nango model: ${model}`)
  }
}
