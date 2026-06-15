// Tiny fetch wrapper. Every call carries the active tenant's API key in the
// Authorization header — switching tenants in the UI swaps this key, which is
// what proves isolation (same screen, different key, different rows).
//
// Requests go to `/api/*`; Vite's dev proxy strips `/api` and forwards to the
// shiplog-sync API on :3000 (see vite.config.ts).
const BASE = '/api'

async function handle<T>(res: Response, method: string, path: string): Promise<T> {
  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.error ?? ''
    } catch {
      /* non-JSON body */
    }
    throw new Error(`${method} ${path} → ${res.status}${detail ? ` (${detail})` : ''}`)
  }
  return res.json() as Promise<T>
}

export async function apiGet<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } })
  return handle<T>(res, 'GET', path)
}

export async function apiPost<T>(apiKey: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return handle<T>(res, 'POST', path)
}

// ---- API response shapes (mirror the backend's lean documents) ----

export interface Connection {
  _id: string
  provider: string
  nangoConnectionId?: string
  status: string
  models: string[]
  createdAt?: string
}

export interface SyncRunCounts {
  added: number
  updated: number
  deleted: number
  failed: number
}

export interface SyncRun {
  _id: string
  trigger: 'webhook' | 'reconcile' | 'backfill'
  status: 'running' | 'success' | 'failed'
  counts: SyncRunCounts
  startedAt?: string
  finishedAt?: string
  createdAt?: string
}

export interface EventRow {
  _id: string
  type: 'commit' | 'issue' | 'pr' | 'release'
  source: string
  externalId: string
  title?: string
  actor?: string
  url?: string
  occurredAt?: string
  version?: string
}

export interface DlqItem {
  _id: string
  errorMessage?: string
  attemptsMade?: number
  failedAt?: string
  replayedAt?: string
  payload?: { record?: { _nango_metadata?: { model?: string } } }
}
