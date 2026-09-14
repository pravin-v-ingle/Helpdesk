import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Mirrors the `@/*` path in tsconfig; shadcn/ui components import through it.
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    // Overridable so the e2e stack can run beside the dev servers
    // (`dev:test` sets 5174 / 3001). Defaults are the dev ports.
    port: Number(process.env.CLIENT_PORT ?? 5173),
    // Dev only. In production the client is served alongside the API,
    // or points at the real API URL.
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
})
