import { useQuery } from '@tanstack/react-query'
import { apiGet, type EventRow } from '../api'

export function EventsTable({ apiKey }: { apiKey: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['events', apiKey],
    queryFn: () => apiGet<{ count: number; events: EventRow[] }>(apiKey, '/events'),
  })

  return (
    <section className="card wide">
      <h2>
        Events <span className="count">{data?.count ?? 0}</span>
      </h2>
      {isLoading && <p className="muted">Loading…</p>}
      {error && <p className="error">{(error as Error).message}</p>}

      {data && data.events.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Title</th>
              <th>Actor</th>
              <th>External ID</th>
              <th>Occurred</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e._id}>
                <td>
                  <span className={`tag tag-${e.type}`}>{e.type}</span>
                </td>
                <td>
                  {e.url ? (
                    <a href={e.url} target="_blank" rel="noreferrer">
                      {e.title || '(untitled)'}
                    </a>
                  ) : (
                    e.title || '(untitled)'
                  )}
                </td>
                <td>{e.actor ?? '—'}</td>
                <td className="muted small">{e.externalId}</td>
                <td className="muted small">
                  {e.occurredAt ? new Date(e.occurredAt).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.events.length === 0 && <p className="muted">No events for this tenant.</p>}
    </section>
  )
}
