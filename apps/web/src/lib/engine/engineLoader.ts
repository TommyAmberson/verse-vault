/**
 * WASM module loader for the browser-side fat-client. The Vite bundler
 * resolves `verse-vault-wasm-web` through pnpm-workspace and emits the
 * `.wasm` binary as an asset. Caller passes the parsed `MaterialData`,
 * the per-user `MaterialConfig`, persisted `TestStateEntry` array, and
 * gets back a typed `WasmEngine` handle.
 *
 * Same Rust source as the server's `verse-vault-wasm` (nodejs target);
 * the contract crate version pinned in apps/web's lockfile must match
 * the API's at sync time so the wire format and replay semantics agree.
 */

import { WasmEngine } from 'verse-vault-wasm-web'

import type { TestStateEntry } from './types'

export interface CreateEngineOpts {
  /** Parsed MaterialData JSON (one deck of structural verse data). */
  materialData: unknown
  /** Per-user MaterialConfig (year/scope toggles, per-club shape). Empty
   *  string for the engine's test-friendly `all_clubs_enabled` fallback
   *  inside `parse_material_config('')` — production always supplies a
   *  real JSON blob. */
  materialConfig: unknown | ''
  /** Per-(user, material) schedule override. Empty string skips the
   *  schedule entirely — the memorize algorithm collapses to pure-
   *  Sequential, matching pre-Phase-1 behaviour for decks that ship no
   *  schedule. Otherwise a JSON `Schedule` matching the bundled shape.
   *  Added in wasm@0.6.0. */
  schedule: unknown | ''
  /** Persisted test states to overlay onto the freshly-seeded engine.
   *  Pass `[]` for a baseline rebuild. */
  testStates: TestStateEntry[]
  /** Unix-seconds wall clock used to seed unseen tests. */
  nowSecs: number
}

/** Build a fresh `WasmEngine` from the given inputs. Callers are
 *  responsible for `.free()`-ing the result when discarding (e.g. on
 *  snapshot version bump).
 *
 *  As of wasm@0.6.0 the standalone `desired_retention` constructor arg
 *  was removed — per-club retention lives inside
 *  `MaterialConfig.review.{club}.desiredRetention`. The `schedule_json`
 *  arg lands in the freed slot. */
export function createEngine(opts: CreateEngineOpts): WasmEngine {
  return new WasmEngine(
    JSON.stringify(opts.materialData),
    opts.materialConfig === '' ? '' : JSON.stringify(opts.materialConfig),
    opts.schedule === '' ? '' : JSON.stringify(opts.schedule),
    JSON.stringify(opts.testStates),
    BigInt(opts.nowSecs),
  )
}

export { WasmEngine }
