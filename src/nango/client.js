import { Nango } from '@nangohq/node'
import { config } from '../config/env.js'
import { githubFixtures } from '../fixtures/github.js'

/**
 * Fixture-backed adapter implementing the slice of the Nango client we use
 * (`listRecords`), so the full webhook → records → events pipeline runs locally
 * without a Nango account. Returns the static fixtures for the requested model.
 */
function fixtureNango() {
  return {
    fixtures: true,
    async listRecords({ model }) {
      const records = githubFixtures.filter((r) => r._nango_metadata?.model === model).map((r) => ({ ...r }))
      return { records, next_cursor: null }
    },
  }
}

/** Real Nango client when a secret key is configured, otherwise the fixture adapter. */
export function createNangoClient() {
  if (config.nangoUseFixtures || !config.nangoSecretKey) return fixtureNango()
  return new Nango({ secretKey: config.nangoSecretKey, host: config.nangoHost })
}
