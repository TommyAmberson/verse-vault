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
  /** Per-user MaterialConfig (year/scope toggles). Empty string for
   *  the engine's `MaterialConfig::default()`. */
  materialConfig: unknown | ''
  /** Persisted test states to overlay onto the freshly-seeded engine.
   *  Pass `[]` for a baseline rebuild. */
  testStates: TestStateEntry[]
  /** Desired-retention parameter for FSRS scheduling (0..=1). 0.9 matches
   *  the server default. */
  desiredRetention: number
  /** Unix-seconds wall clock used to seed unseen tests. */
  nowSecs: number
}

/** Build a fresh `WasmEngine` from the given inputs. Callers are
 *  responsible for `.free()`-ing the result when discarding (e.g. on
 *  snapshot version bump). */
export function createEngine(opts: CreateEngineOpts): WasmEngine {
  return new WasmEngine(
    JSON.stringify(opts.materialData),
    opts.materialConfig === '' ? '' : JSON.stringify(opts.materialConfig),
    JSON.stringify(opts.testStates),
    opts.desiredRetention,
    BigInt(opts.nowSecs),
  )
}

export { WasmEngine }
