import { TENANTS, type TenantOption } from '../tenants'

export function TenantSwitcher({
  tenant,
  onChange,
}: {
  tenant: TenantOption
  onChange: (t: TenantOption) => void
}) {
  return (
    <div className="switcher">
      <label htmlFor="tenant">Tenant</label>
      <select
        id="tenant"
        value={tenant.id}
        onChange={(e) => onChange(TENANTS.find((t) => t.id === e.target.value)!)}
      >
        {TENANTS.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  )
}
