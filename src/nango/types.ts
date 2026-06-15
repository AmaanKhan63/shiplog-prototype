// Shape of what Nango's records API / webhooks hand us. Loose by design — the
// provider's own fields ride alongside `_nango_metadata`, and the normalizer is
// what narrows a record into the typed event contract.

export interface NangoMetadata {
  model?: string
  cursor?: string
  deleted_at?: string | null
  last_action?: string
  last_modified_at?: string
  first_seen_at?: string
  [key: string]: unknown
}

export interface NangoRecord {
  id: string | number
  _nango_metadata?: NangoMetadata
  [key: string]: unknown
}

export interface NangoListResult {
  records: NangoRecord[]
  next_cursor?: string | null
}

export interface NangoListParams {
  providerConfigKey: string
  connectionId: string
  model: string
  cursor?: string | null
  modifiedAfter?: string
}

// The slice of the Nango client we depend on (the real SDK and the fixture
// adapter both satisfy this).
export interface NangoClientLike {
  fixtures?: boolean
  listRecords(params: NangoListParams): Promise<NangoListResult>
}
