import { config } from './config/env.js'
import { connectDB } from './db/connect.js'
import { buildApp } from './app.js'

async function main() {
  await connectDB(config.mongoUri)
  const app = buildApp()
  app.listen(config.port, () => {
    console.log(`shiplog-sync API listening on http://localhost:${config.port}`)
  })
}

main().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
