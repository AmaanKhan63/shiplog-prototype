/**
 * Simulate a Nango sync webhook against the running API (local verification
 * without a Nango account). Requires NANGO_WEBHOOK_SECRET set (any value) so the
 * signature can be verified, the API (`npm start`) and worker (`npm run worker`)
 * running, and a connection registered (`npm run connect <connectionId>`).
 *
 *   npm run simulate-webhook [model] [connectionId]
 *
 * With NANGO_USE_FIXTURES (the default), the worker serves the static fixtures
 * for the requested model, so the records flow through to events.
 */
import { createHmac } from 'node:crypto'
import { config } from '../src/config/env.js'

const model = process.argv[2] || 'GithubIssue'
const connectionId = process.argv[3] || 'nc-local'

if (!config.nangoWebhookSecret) {
  console.error('Set NANGO_WEBHOOK_SECRET in .env (any value) so the webhook signature can be verified.')
  process.exit(2)
}

async function main() {
  const payload = JSON.stringify({
    type: 'sync', connectionId, providerConfigKey: 'github', syncName: `github-${model}`,
    model, syncType: 'INCREMENTAL', success: true, modifiedAfter: new Date(0).toISOString(),
    responseResults: { added: 0, updated: 0, deleted: 0 },
  })
  const signature = createHmac('sha256', config.nangoWebhookSecret).update(payload).digest('hex')

  const res = await fetch(`http://localhost:${config.port}/webhooks/nango`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nango-Hmac-Sha256': signature },
    body: payload,
  })
  console.log(`POST /webhooks/nango (model=${model}, connectionId=${connectionId}) -> HTTP ${res.status}`)
  console.log(await res.text())
  console.log(`\nThe worker now fetches ${model} records and ingests them. Verify with:`)
  console.log('  curl -H "Authorization: Bearer demo-api-key" http://localhost:%s/events', config.port)
}

main().catch((err) => { console.error(err); process.exit(1) })
