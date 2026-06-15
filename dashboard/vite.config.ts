import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dashboard is served by Vite on :5173 and talks to the shiplog-sync API on
// :3000. Rather than enabling CORS on the backend, we proxy `/api/*` to the API
// and strip the `/api` prefix — so the browser makes same-origin calls and the
// backend routes (`/events`, `/dlq`, ...) stay exactly as the rest of the repo
// uses them.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
