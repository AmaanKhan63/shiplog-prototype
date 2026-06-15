import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiPost, type DlqItem } from '../api'

export function DlqPanel({ apiKey }: { apiKey: string }) {
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['dlq', apiKey],
    queryFn: () => apiGet<{ count: number; items: DlqItem[] }>(apiKey, '/dlq'),
  })

  // Replay re-enqueues the item's original payload verbatim and stamps
  // `replayedAt` — it does NOT delete the row, so the item stays listed (now
  // marked "replayed"). The re-flowed event shows up in the Events panel once
  // the worker processes it.
  const replay = useMutation({
    mutationFn: (id: string) => apiPost(apiKey, `/dlq/${id}/replay`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dlq', apiKey] })
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['dlq', apiKey] })
        qc.invalidateQueries({ queryKey: ['events', apiKey] })
        qc.invalidateQueries({ queryKey: ['sync-runs', apiKey] })
      }, 1500)
    },
  })

  return (
    <section className="card">
      <h2>
        Dead-Letter Queue <span className="count">{data?.count ?? 0}</span>
      </h2>
      {isLoading && <p className="muted">Loading…</p>}
      {error && <p className="error">{(error as Error).message}</p>}
      {replay.isError && <p className="error">{(replay.error as Error).message}</p>}
      {data && data.items.length === 0 && <p className="muted">Empty — nothing dead-lettered. ✓</p>}

      {data?.items.map((it) => (
        <div key={it._id} className="dlq-row">
          <div className="dlq-main">
            <div className="error-msg">{it.errorMessage ?? 'unknown error'}</div>
            <div className="muted small">
              {it.payload?.record?._nango_metadata?.model ?? 'record'} · {it.attemptsMade ?? '?'} attempt(s)
              {it.replayedAt && <span className="badge success replayed">replayed</span>}
            </div>
          </div>
          <button
            disabled={replay.isPending && replay.variables === it._id}
            onClick={() => replay.mutate(it._id)}
          >
            Replay
          </button>
        </div>
      ))}
    </section>
  )
}
