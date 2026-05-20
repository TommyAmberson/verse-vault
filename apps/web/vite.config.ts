import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  // VITE_BASE_PATH lets the production build emit asset URLs prefixed for a
  // subpath deploy (e.g. `/vv/` while we co-host under versevault.ca). Local
  // dev and root-domain builds get the default `/`.
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [vue()],
  server: { port: 5180, strictPort: true },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
