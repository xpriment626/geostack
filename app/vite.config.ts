import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const CORAL_HTTP = 'http://localhost:5555'
const CORAL_WS = 'ws://localhost:5555'

export default defineConfig(({ mode }) => {
  // .env lives at the trial root, alongside agents/. Keeps app/ and agents/
  // pointed at one source of truth for credentials.
  const env = loadEnv(mode, '..', '')
  const replicateToken = env.VITE_REPLICATE_API_TOKEN || ''

  return {
    plugins: [svelte()],
    envDir: '..',
    server: {
      port: 5173,
      proxy: {
        '/api': { target: CORAL_HTTP, changeOrigin: true },
        '/ws': { target: CORAL_WS, ws: true, changeOrigin: true },
        // Replicate proxy — adds the bearer token server-side so the browser
        // never sees it, sidesteps CORS, and lets us treat Replicate as a
        // first-party endpoint at /replicate/*.
        '/replicate': {
          target: 'https://api.replicate.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/replicate/, '/v1'),
          headers: replicateToken
            ? { Authorization: `Bearer ${replicateToken}` }
            : {},
        },
      },
    },
  }
})
