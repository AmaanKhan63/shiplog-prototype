/**
 * Static Nango-shaped GitHub records (what Nango's records API / webhooks hand
 * us). Stands in for a real Nango GitHub sync until Milestone 4. Each record
 * carries `_nango_metadata.model` plus the provider's own fields.
 *
 * 6 records: 2 issues, 2 pull requests, 2 commits.
 */
export const githubFixtures = [
  {
    id: 'gh_issue_101',
    _nango_metadata: { model: 'GithubIssue', cursor: 'c-101', last_modified_at: '2024-03-01T12:00:00Z', deleted_at: null },
    number: 101,
    title: 'Checkout fails on Safari 17',
    state: 'open',
    html_url: 'https://github.com/acme/storefront/issues/101',
    user: { login: 'arav' },
    created_at: '2024-02-20T09:15:00Z',
    updated_at: '2024-03-01T12:00:00Z',
  },
  {
    id: 'gh_issue_102',
    _nango_metadata: { model: 'GithubIssue', cursor: 'c-102', last_modified_at: '2024-03-02T08:30:00Z', deleted_at: null },
    number: 102,
    title: 'Add dark mode to dashboard',
    state: 'open',
    html_url: 'https://github.com/acme/storefront/issues/102',
    user: { login: 'mira' },
    created_at: '2024-02-25T14:00:00Z',
    updated_at: '2024-03-02T08:30:00Z',
  },
  {
    id: 'gh_pr_7',
    _nango_metadata: { model: 'GithubPullRequest', cursor: 'c-pr7', last_modified_at: '2024-03-03T16:45:00Z', deleted_at: null },
    number: 7,
    title: 'Fix Safari checkout regression',
    state: 'open',
    html_url: 'https://github.com/acme/storefront/pull/7',
    user: { login: 'arav' },
    created_at: '2024-03-02T10:00:00Z',
    updated_at: '2024-03-03T16:45:00Z',
  },
  {
    id: 'gh_pr_8',
    _nango_metadata: { model: 'GithubPullRequest', cursor: 'c-pr8', last_modified_at: '2024-03-04T11:20:00Z', deleted_at: null },
    number: 8,
    title: 'Introduce dark mode tokens',
    state: 'open',
    html_url: 'https://github.com/acme/storefront/pull/8',
    user: { login: 'mira' },
    created_at: '2024-03-03T09:30:00Z',
    updated_at: '2024-03-04T11:20:00Z',
  },
  {
    id: 'gh_commit_a',
    _nango_metadata: { model: 'GithubCommit', cursor: 'c-cmta', last_modified_at: '2024-03-03T15:00:00Z', deleted_at: null },
    sha: '9a1f3c2',
    html_url: 'https://github.com/acme/storefront/commit/9a1f3c2',
    author: { login: 'arav' },
    commit: { message: 'Guard Safari date parsing\n\nFixes #101', author: { name: 'Arav', date: '2024-03-03T15:00:00Z' } },
  },
  {
    id: 'gh_commit_b',
    _nango_metadata: { model: 'GithubCommit', cursor: 'c-cmtb', last_modified_at: '2024-03-04T10:05:00Z', deleted_at: null },
    sha: 'b7d4e90',
    html_url: 'https://github.com/acme/storefront/commit/b7d4e90',
    author: { login: 'mira' },
    commit: { message: 'Add dark mode color tokens', author: { name: 'Mira', date: '2024-03-04T10:05:00Z' } },
  },
]
