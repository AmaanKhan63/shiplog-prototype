import { useQuery } from '@tanstack/react-query'
import { apiGet, type SyncRun } from '../api'

function duration(run: SyncRun): string {
  if (!run.startedAt || !run.finishedAt) return run.status === 'running' ? '…' : '—'
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function when(run: SyncRun): string {
  const t = run.startedAt ?? run.createdAt
  return t ? new Date(t).toLocaleTimeString() : '—'
}

export function SyncRunsTable({ apiKey }: { apiKey: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['sync-runs', apiKey],
    queryFn: () => apiGet<{ count: number; runs: SyncRun[] }>(apiKey, '/sync-runs'),
  })

  return (
    <section className="card">
      <h2>
        Sync Runs <span className="count">{data?.count ?? 0}</span>
      </h2>
      {isLoading && <p className="muted">Loading…</p>}
      {error && <p className="error">{(error as Error).message}</p>}

      {data && data.runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Trigger</th>
              <th className="num">+</th>
              <th className="num">~</th>
              <th className="num">−</th>
              <th className="num">✕</th>
              <th className="num">Duration</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r._id}>
                <td>
                  <span className={`badge ${r.status}`}>{r.status}</span>
                </td>
                <td>{r.trigger}</td>
                <td className="num">{r.counts.added}</td>
                <td className="num">{r.counts.updated}</td>
                <td className="num">{r.counts.deleted}</td>
                <td className="num">{r.counts.failed}</td>
                <td className="num">{duration(r)}</td>
                <td className="muted small">{when(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.runs.length === 0 && <p className="muted">No sync runs yet.</p>}
      <p className="legend">+ added · ~ updated · − deleted · ✕ failed</p>
    </section>
  )
}
