import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import topLevelAwait from 'vite-plugin-top-level-await'
import wasm from 'vite-plugin-wasm'
import { defineConfig } from 'vite'

export default defineConfig({
  // VITE_BASE_PATH lets the production build emit asset URLs prefixed for a
  // subpath deploy (e.g. `/vv/` while we co-host under versevault.ca). Local
  // dev and root-domain builds get the default `/`.
  base: process.env.VITE_BASE_PATH ?? '/',
  // verse-vault-wasm-web is built with `wasm-pack --target bundler`,
  // which emits an ESM module that imports the .wasm binary directly.
  // vite-plugin-wasm handles the bundler-target import; the
  // top-level-await companion ships TLA support for the slightly
  // older browser targets in vite's default baseline.
  plugins: [wasm(), topLevelAwait(), vue()],
  build: {
    // Bump above vite's default chrome87/firefox78/safari14 baseline so
    // wasm-bindgen's generated JS (which uses object destructuring in
    // top-level code) compiles cleanly. ES2022 covers Chrome 94+,
    // Firefox 93+, Safari 15.4+ — every browser that supports
    // WebAssembly streaming compilation already meets this anyway.
    target: 'es2022',
  },
  // 5180 keeps verse-vault clear of qzr-sheet (which runs Vite on
  // 5173 / 5174 without strictPort). Must match src-tauri/tauri.conf.json
  // `devUrl`. strictPort: true so Vite errors loudly if the port is
  // taken rather than drifting onto one Tauri can't find.
  server: { port: 5180, strictPort: true },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
