import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Integration tests share one local mongod + test DB. Run every file in a
    // single fork, serially, so they never race on the same collections or on
    // the shared mongoose connection handle.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 30000,
    testTimeout: 30000,
  },
})
