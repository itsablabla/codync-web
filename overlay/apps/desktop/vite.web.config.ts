import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Browser build of the desktop renderer, talking to a real codync-host through the
// same-origin proxy (proxy/server.mjs). Modeled on vite.demo.config.ts, but the bridge
// (src/renderer/web/bridge.ts) hits the host's HTTP API instead of the in-memory fake.
export default defineConfig({
  root: resolve('src/renderer/web'),
  publicDir: resolve('src/renderer/public'),
  // Relative, so the bundle works however the proxy serves it.
  base: './',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react()],
  build: { outDir: resolve('dist-web'), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
