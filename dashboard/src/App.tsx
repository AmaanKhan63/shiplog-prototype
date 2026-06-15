import { useState } from 'react'
import { TENANTS } from './tenants'
import { TenantSwitcher } from './components/TenantSwitcher'
import { SyncControl } from './components/SyncControl'
import { SyncRunsTable } from './components/SyncRunsTable'
import { DlqPanel } from './components/DlqPanel'
import { EventsTable } from './components/EventsTable'

export function App() {
  const [tenant, setTenant] = useState(TENANTS[0])

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <h1>shiplog-sync</h1>
          <p className="subtitle">ingestion + resilience dashboard</p>
        </div>
        <TenantSwitcher tenant={tenant} onChange={setTenant} />
      </header>

      <div className="banner">
        Viewing <strong>{tenant.name}</strong> — every panel below is scoped to this tenant's API key.
        Switch tenants to see isolation: the data changes, nothing leaks.
      </div>

      {/* `key={tenant.apiKey}` remounts the panels on switch; combined with
          per-tenant query keys, no previous tenant's rows can ever flash. */}
      <main className="grid" key={tenant.apiKey}>
        <SyncControl apiKey={tenant.apiKey} />
        <SyncRunsTable apiKey={tenant.apiKey} />
        <DlqPanel apiKey={tenant.apiKey} />
        <EventsTable apiKey={tenant.apiKey} />
      </main>
    </div>
  )
}
