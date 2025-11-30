import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
  resolve: {
    alias: {
      '@ts-client': fileURLToPath(new URL('../ts-client/src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    fs: {
      allow: ['..']
    }
  },
  build: {
    target: 'esnext'
  }
})
