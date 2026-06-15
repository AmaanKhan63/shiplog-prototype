import 'dotenv/config'

export const config = {
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/shiplog-sync',
  port: Number(process.env.PORT) || 3000,
}
