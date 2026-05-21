/**
 * Wire types for the browser-side fat-client. Mirrors the server's
 * `packages/api/src/lib/engine.ts` and `packages/api/src/routes/sync.ts`
 * shapes; kept in sync by hand for now.
 *
 * TODO: extract into a shared `packages/contracts/` workspace package so
 * server and client can't drift.
 */

/** FSRS rating: 1=Again, 2=Hard, 3=Good, 4=Easy. Duplicated from
 *  `api.ts` to avoid a circular import — both files reference this
 *  shape, and api.ts depends on this module for the sync types. */
export type Grade = 1 | 2 | 3 | 4

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
