/**
 * Wire types for the browser-side fat-client. Mirrors the server's
 * `packages/api/src/lib/engine.ts` and `packages/api/src/routes/sync.ts`
 * shapes; kept in sync by hand for now.
 *
 * TODO: extract into a shared `packages/contracts/` workspace package so
 * server and client can't drift.
 */

import type { PerClubYearSettings } from '../../api'

/** FSRS rating: 1=Again, 2=Hard, 3=Good, 4=Easy. Duplicated from
 *  `api.ts` to avoid a circular import — both files reference this
 *  shape, and api.ts depends on this module for the sync types. */
export type Grade = 1 | 2 | 3 | 4

/** Wire-format MaterialConfig consumed by the WASM engine's
 *  constructor. Structurally identical to the API's per-club
 *  `PerClubYearSettings` (`api.ts`), which mirrors the server's
 *  `configJson` blob (`packages/api/src/lib/engine.ts`
 *  `readMaterialConfigJson`) and `crates/core::MaterialConfigRaw`.
 *  Aliased rather than re-declared so the engine-wire shape can't
 *  drift from the shape the API returns — that drift was the root
 *  cause of #107 symptom C. Field names are camelCase; Rust accepts
 *  them as aliases for the underlying snake_case struct.
 *
 *  The `api.ts` ↔ this-module import is mutual but type-only, so it
 *  compiles away with no runtime cycle. */
export type WireMaterialConfig = PerClubYearSettings

/** Snapshot of one `(TestKind, ElementId)` pair from the WASM engine.
 *  Mirrors `verse-vault-wasm` `TestStateEntry`. The `element` field is
 *  the serde-tagged JSON form of `ElementId` and is round-tripped opaque. */
export interface TestStateEntry {
  element: unknown
  test_kind: string
  stability: number
  difficulty: number
  last_seen_secs: number
  last_base_secs: number
  last_root_secs: number
  pending_relearn: boolean
}

/** Mirrors `verse-vault-wasm` `TestUpdateWire`. The shape the engine
 *  returns from `replay_event`. */
export interface TestUpdateWire {
  key: { kind: string; element: unknown }
  kind: 'Root' | 'Sub'
}

/** GET /api/sync/:materialId/state response. */
export interface SyncStateResponse {
  snapshot: {
    version: number
    /** Parsed MaterialData JSON. */
    materialData: unknown
  }
  testStates: TestStateEntry[]
  lastEventId: string | null
  /** Verse ids the user has graduated. Cards default to `New` when the
   *  engine is constructed from materialData + testStates; the client
   *  flips each of these to `Active` via `engine.graduate_verse` after
   *  build so the in-memory engine matches the user's actual progress
   *  across page reloads. */
  graduatedVerseIds: number[]
  /** Card ids the user has graduated individually — HP, CCL, and the
   *  conditional verse-bound kinds. Applied via `engine.graduate_card`
   *  alongside the verse-bulk replay. */
  graduatedCardIds: number[]
}

/** One queued event in `POST /api/sync/:materialId/events`. Mirrors the
 *  server's `SyncEventUpload` discriminated union. */
export type SyncEventUpload =
  | {
      kind: 'review'
      clientEventId: string
      timestampSecs: number
      snapshotVersion: number
      cardId: number
      grade: Grade
    }
  | {
      kind: 'graduate'
      clientEventId: string
      timestampSecs: number
      snapshotVersion: number
      verseId: number
    }
  | {
      kind: 'graduateCard'
      clientEventId: string
      timestampSecs: number
      snapshotVersion: number
      cardId: number
    }

/** POST /api/sync/:materialId/events body. */
export interface SyncEventsRequest {
  events: SyncEventUpload[]
  /** Set true when re-POSTing after the stale-merge confirmation modal. */
  confirmMerge?: boolean
}

/** POST /api/sync/:materialId/events response. Two shapes: the normal
 *  merge result, or the stale-merge preflight envelope. */
export type SyncEventsResponse =
  | {
      needsConfirm: true
      staleSummary: {
        queuedCount: number
        serverEventsSince: number
        oldestQueuedTs: number
        newestServerTs: number
      }
    }
  | {
      needsConfirm?: false
      accepted: number
      duplicates: number
      rebuilt: boolean
      testStates: TestStateEntry[]
      lastEventId: string | null
    }
