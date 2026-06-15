import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiPost, type Connection } from '../api'

interface EnqueueResult {
  enqueued: number
}

export function SyncControl({ apiKey }: { apiKey: string }) {
  const qc = useQueryClient()
  const [msg, setMsg] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['connections', apiKey],
    queryFn: () => apiGet<{ count: number; connections: Connection[] }>(apiKey, '/connections'),
  })

  // Reconcile/backfill flow through the worker asynchronously, so refresh the
  // dependent panels twice: immediately (sync_runs row appears) and after a beat
  // (events / DLQ reflect what the worker processed).
  const refreshDependents = () => {
    for (const key of [['sync-runs', apiKey], ['events', apiKey], ['dlq', apiKey]]) {
      qc.invalidateQueries({ queryKey: key })
    }
  }

  const reconcile = useMutation({
    mutationFn: (id: string) => apiPost<EnqueueResult>(apiKey, `/connections/${id}/reconcile`),
    onSuccess: (r) => {
      setMsg(`Reconcile enqueued — ${r.enqueued} model(s) polling Nango on the durable cursor.`)
      refreshDependents()
      setTimeout(refreshDependents, 1500)
    },
    onError: (e: Error) => setMsg(e.message),
  })

  const backfill = useMutation({
    mutationFn: (id: string) => apiPost<EnqueueResult>(apiKey, `/connections/${id}/backfill`),
    onSuccess: (r) => {
      setMsg(`Backfill enqueued — reprocessing ${r.enqueued} raw record(s) (idempotent, no duplicates).`)
      refreshDependents()
      setTimeout(refreshDependents, 1500)
    },
    onError: (e: Error) => setMsg(e.message),
  })

  // Only the connection whose mutation is in flight gets its buttons disabled, so
  // actions on other connections stay available.
  const pendingId = reconcile.isPending ? reconcile.variables : backfill.isPending ? backfill.variables : null

  return (
    <section className="card">
      <h2>Sync Control</h2>
      {isLoading && <p className="muted">Loading…</p>}
      {error && <p className="error">{(error as Error).message}</p>}
      {data?.connections.length === 0 && <p className="muted">No connections for this tenant.</p>}

      {data?.connections.map((c) => (
        <div key={c._id} className="conn-row">
          <div>
            <div className="conn-name">{c.nangoConnectionId ?? c._id}</div>
            <div className="muted small">
              {c.provider} · {c.models.join(', ')} · {c.status}
            </div>
          </div>
          <div className="btn-group">
            <button disabled={pendingId === c._id} onClick={() => reconcile.mutate(c._id)}>
              Reconcile
            </button>
            <button disabled={pendingId === c._id} onClick={() => backfill.mutate(c._id)}>
              Backfill
            </button>
          </div>
        </div>
      ))}

      {msg && <p className="status">{msg}</p>}
    </section>
  )
}
