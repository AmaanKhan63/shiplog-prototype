import { defineConfig } from 'vitest/config'

// Infrastructure-dependent tests (require a live Redis). Run via
// `npm run test:integration`. The test self-skips if no Redis is reachable.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.js'],
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
})
