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
export function normalizeGithubRecord(record) {
  const model = record?._nango_metadata?.model

  switch (model) {
    case 'GithubIssue':
      return {
        source: 'github',
        type: 'issue',
        externalId: `issue:${record.number}`,
        actor: record.user?.login ?? 'unknown',
        title: record.title,
        url: record.html_url,
        occurredAt: new Date(record.created_at),
        version: record.updated_at,
      }

    case 'GithubPullRequest':
      return {
        source: 'github',
        type: 'pr',
        externalId: `pr:${record.number}`,
        actor: record.user?.login ?? 'unknown',
        title: record.title,
        url: record.html_url,
        occurredAt: new Date(record.created_at),
        version: record.updated_at,
      }

    case 'GithubCommit':
      return {
        source: 'github',
        type: 'commit',
        externalId: `commit:${record.sha}`,
        actor: record.author?.login ?? record.commit?.author?.name ?? 'unknown',
        title: (record.commit?.message ?? '').split('\n')[0],
        url: record.html_url,
        occurredAt: new Date(record.commit?.author?.date),
        version: record.sha,
      }

    default:
      throw new Error(`Unknown Nango model: ${model}`)
  }
}
