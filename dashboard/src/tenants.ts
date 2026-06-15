// The demo tenants the switcher offers. These are *demo* API keys (the same ones
// `npm run seed` creates), deliberately baked into the client: it avoids a
// cross-tenant `/tenants` endpoint that would itself violate the isolation model
// this dashboard exists to demonstrate. In a real product, the key would come
// from the authenticated session, not a dropdown.
export interface TenantOption {
  id: string
  name: string
  apiKey: string
}

export const TENANTS: TenantOption[] = [
  { id: 'acme', name: 'Demo (Acme Storefront)', apiKey: 'demo-api-key' },
  { id: 'globex', name: 'Globex Industries', apiKey: 'demo-api-key-2' },
]
