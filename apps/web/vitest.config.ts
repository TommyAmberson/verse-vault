import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'

// Deliberately not extending vite.config.ts. That config loads
// vite-plugin-wasm to bundle `verse-vault-wasm-web`, so reusing it would
// make every test run depend on a built `crates/wasm/pkg-web` — a stale
// or missing one would fail suites that never touch the engine. The
// units under test here are plain TypeScript.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
