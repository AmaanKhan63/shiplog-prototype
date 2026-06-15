import { describe, it, expect } from 'vitest'
import { normalizeGithubRecord } from '../src/normalize/github.js'

const issue = {
  id: 'nango-rec-1',
  _nango_metadata: { model: 'GithubIssue' },
  number: 42,
  title: 'Login button is broken',
  state: 'open',
  html_url: 'https://github.com/acme/app/issues/42',
  user: { login: 'octocat' },
  created_at: '2024-01-01T10:00:00Z',
  updated_at: '2024-01-02T10:00:00Z',
}

const commit = {
  id: 'nango-rec-2',
  _nango_metadata: { model: 'GithubCommit' },
  sha: 'abc123def456',
  html_url: 'https://github.com/acme/app/commit/abc123def456',
  author: { login: 'hubot' },
  commit: { message: 'Fix login\n\nLonger body', author: { name: 'Hubot', date: '2024-01-03T09:00:00Z' } },
}

const pr = {
  id: 'nango-rec-3',
  _nango_metadata: { model: 'GithubPullRequest' },
  number: 7,
  title: 'Add OAuth',
  state: 'open',
  html_url: 'https://github.com/acme/app/pull/7',
  user: { login: 'octocat' },
  created_at: '2024-01-04T08:00:00Z',
  updated_at: '2024-01-05T08:00:00Z',
}

describe('normalizeGithubRecord', () => {
  it('maps a GithubIssue to a typed event (version = updated_at, occurredAt = created_at)', () => {
    const e = normalizeGithubRecord(issue)
    expect(e).toMatchObject({
      source: 'github',
      type: 'issue',
      externalId: 'issue:42',
      actor: 'octocat',
      title: 'Login button is broken',
      url: 'https://github.com/acme/app/issues/42',
      version: '2024-01-02T10:00:00Z',
    })
    expect(e.occurredAt).toEqual(new Date('2024-01-01T10:00:00Z'))
  })

  it('maps a GithubCommit (externalId = sha, version = sha, title = first line)', () => {
    const e = normalizeGithubRecord(commit)
    expect(e).toMatchObject({
      source: 'github',
      type: 'commit',
      externalId: 'commit:abc123def456',
      actor: 'hubot',
      title: 'Fix login',
      version: 'abc123def456',
    })
    expect(e.occurredAt).toEqual(new Date('2024-01-03T09:00:00Z'))
  })

  it('maps a GithubPullRequest', () => {
    const e = normalizeGithubRecord(pr)
    expect(e).toMatchObject({ source: 'github', type: 'pr', externalId: 'pr:7', actor: 'octocat', version: '2024-01-05T08:00:00Z' })
  })

  it('distinguishes an issue and a PR that share a number', () => {
    const e1 = normalizeGithubRecord({ ...issue, number: 7 })
    const e2 = normalizeGithubRecord(pr)
    expect(e1.externalId).not.toBe(e2.externalId)
  })

  it('throws on an unknown Nango model', () => {
    expect(() => normalizeGithubRecord({ _nango_metadata: { model: 'GithubGist' } })).toThrow(/unknown nango model/i)
  })
})
