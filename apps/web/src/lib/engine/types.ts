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
  /** Fingerprint of the event + graduation logs this response was built
   *  from. Stored with the cached snapshot; compared against the
   *  /api/years value on later boots to detect server-side changes.
   *  Optional so an older API keeps working. */
  stateRev?: string
  /** An open stale-merge question for this material, raised on the
   *  server by an earlier upload from any device. Optional so an older
   *  API keeps working. */
  pendingConfirmation?: StaleMergeSummary | null
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
  /** Answers the stale-merge question by re-sending the batch. Only for
   *  an older server that took nothing; a current one is answered
   *  through `POST .../confirm`. */
  confirmMerge?: boolean
}

/** What the server did with one uploaded event, by position. The client
 *  never decides deletion by dispositions; their absence is what marks an
 *  older server's stale-merge envelope as having taken nothing. */
export interface EventDisposition {
  index: number
  clientEventId: string | null
  disposition: 'applied' | 'duplicate' | 'pending' | 'unusable'
  reasonCode?: string
  reason?: string
}

/** An open stale-merge question: a batch too far behind to merge
 *  without asking (see the sync route's `STALE_MERGE_THRESHOLD`), held
 *  on the server until the learner answers. Drives the modal. */
export interface StaleMergeSummary {
  queuedCount: number
  serverEventsSince: number
  oldestQueuedTs: number
  newestServerTs: number
}

/** POST /api/sync/:materialId/events response. The first arm is an
 *  older server's stale-merge envelope, which took nothing; a current
 *  server always answers with the second, flagging a held batch with
 *  `needsConfirm` beside the usual fields. */
export type SyncEventsResponse =
  | {
      needsConfirm: true
      staleSummary: StaleMergeSummary
      dispositions?: undefined
    }
  | {
      /** Set when the batch was taken but held, awaiting the learner. */
      needsConfirm?: boolean
      staleSummary?: StaleMergeSummary | null
      /** One per uploaded event. Absent from older servers. */
      dispositions?: EventDisposition[]
      accepted: number
      duplicates: number
      rebuilt: boolean
      testStates: TestStateEntry[]
      lastEventId: string | null
      /** Post-merge state fingerprint — the flush stores it on the
       *  cached snapshot so its own write doesn't read as staleness on
       *  the next boot. Optional so an older API keeps working. */
      stateRev?: string
    }

/** POST /api/sync/:materialId/confirm response: a merge answers like an
 *  upload without dispositions, a discard with how many were set aside. */
export type SyncConfirmResponse =
  | { discarded: number }
  | {
      accepted: number
      duplicates: number
      rebuilt: boolean
      testStates: TestStateEntry[]
      lastEventId: string | null
      stateRev?: string
    }
