import { Nango } from '@nangohq/node'
import { config } from '../config/env.js'
import { githubFixtures } from '../fixtures/github.js'
import type { NangoClientLike, NangoListParams, NangoListResult } from './types.js'

/**
 * Fixture-backed adapter implementing the slice of the Nango client we use
 * (`listRecords`), so the full webhook → records → events pipeline runs locally
 * without a Nango account. Returns the static fixtures for the requested model.
 */
function fixtureNango(): NangoClientLike {
  return {
    fixtures: true,
    async listRecords({ model }: NangoListParams): Promise<NangoListResult> {
      const records = githubFixtures.filter((r) => r._nango_metadata?.model === model).map((r) => ({ ...r }))
      return { records, next_cursor: null }
    },
  }
}

/** Real Nango client when a secret key is configured, otherwise the fixture adapter. */
export function createNangoClient(): NangoClientLike {
  if (config.nangoUseFixtures || !config.nangoSecretKey) return fixtureNango()
  // The SDK's listRecords is generically typed and broader than the slice we use;
  // narrow it to our NangoClientLike contract (runtime shape is compatible).
  return new Nango({ secretKey: config.nangoSecretKey, host: config.nangoHost }) as unknown as NangoClientLike
}
