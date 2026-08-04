import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'

// Deliberately not extending vite.config.ts. That config loads
// vite-plugin-wasm to bundle `verse-vault-wasm-web`, so reusing it would
// make every test depend on a built `crates/wasm/pkg-web` — a stale or
// missing one would fail suites that never touch the engine. The units
// under test here are plain TypeScript.
export default defineConfig({
  test: {
    // Non-UTC on purpose. `parseIsoDate` anchors every date at
    // `T00:00:00Z` specifically so weekdays don't drift west of UTC, and
    // under the default `TZ=UTC` a regression to naive local-time parsing
    // passes every assertion. Runners default to UTC, so without this the
    // guarantee would only ever be checked on a developer's machine.
    env: { TZ: 'America/Edmonton' },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
