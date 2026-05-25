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
      // Pinned to 5174 (strict) so it never silently collides with a sibling
      // project on the Vite default 5173 (e.g. fabrick).
      port: 5174,
      strictPort: true,
      proxy: {
        '/api': { target: CORAL_HTTP, changeOrigin: true },
        '/ws': { target: CORAL_WS, ws: true, changeOrigin: true },
        // GEO Content Fleet conductor (run archive + orchestration API).
        // Namespaced so the inspector view fetches /conductor/runs etc.
        // without colliding with any app route, mirroring the Coral proxy.
        '/conductor': {
          target: 'http://localhost:8787',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/conductor/, ''),
        },
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
