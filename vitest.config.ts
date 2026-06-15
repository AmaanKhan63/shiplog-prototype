import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The live-Redis BullMQ end-to-end test is infrastructure-dependent and runs
    // via `npm run test:integration`. The default suite stays Redis-free, fast,
    // and reliable; the queue's *logic* is fully covered by deterministic unit
    // tests (errors, backoff, processor, deadLetter).
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    // Mongo integration tests share one local mongod; run serially.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
})
