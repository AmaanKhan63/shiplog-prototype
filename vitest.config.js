import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Integration tests share one local mongod + test DB; run files serially
    // so they don't race on the same collections.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
  },
})
