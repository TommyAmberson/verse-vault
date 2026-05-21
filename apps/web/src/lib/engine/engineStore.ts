/**
 * Browser-side engine orchestration. Sits between the Vue views (via the
 * `useEngine` composable) and the WASM module + IDB layer.
 *
 * Owns the singleton `Map<materialId, EngineSession>`: one `WasmEngine`
 * instance per material, kept alive across navigations. State persists
 * to IDB (`./persistence`) so a page reload warm-starts from cache;
 * `/api/sync/:materialId/state` is the network of last resort.
 *
 * Mutation paths:
 *   - `submitGrade` runs `engine.replay_event` locally, returns updates
 *     synchronously, and appends a `kind: 'review'` event to the IDB
 *     queue. A background flush ships it to the server.
 *   - `submitGraduation` runs `engine.graduate_verse` locally and
 *     appends a `kind: 'graduate'` event.
 *   - `flush` POSTs the queue to `/api/sync/:materialId/events`, applies
 *     the server's response (including a `rebuilt: true` wholesale
 *     state replacement), and deletes acked events by clientEventId.
 *
 * Reads:
 *   - `getCardRender` checks the IDB `renders` cache (MAUA-compliant
 *     TTL), falls back to `/api/cards/:id`, and stores the result.
 *
 * Concurrency: per-material flushes are coalesced via `inflightFlushes`
 * so simultaneous callers share one network round-trip.
 */

import { type CardRender, api } from '../../api'
import { createEngine, type WasmEngine } from './engineLoader'
import * as idb from './persistence'
import type {
  Grade,
  SyncEventUpload,
  SyncEventsResponse,
  TestStateEntry,
  TestUpdateWire,
  WireMaterialConfig,
} from './types'

const DEFAULT_DESIRED_RETENTION = 0.9

export interface EngineSession {
  materialId: string
  engine: WasmEngine
  snapshotVersion: number
}

const sessions = new Map<string, EngineSession>()
const inflightFlushes = new Map<string, Promise<FlushResult>>()

/** Outcome of a flush attempt. Surfaced to callers (the useEngine
 *  composable) so the UI can show stale-merge prompts or
 *  rebuilt-state indicators. */
export interface FlushResult {
  /** Events successfully merged into the server log. */
  accepted: number
  /** Events the server treated as duplicates (clientEventId already seen
   *  or graduate no-op). */
  duplicates: number
  /** True when the server triggered a full-log rebuild — the client
   *  already adopted the rebuilt testStates. */
  rebuilt: boolean
  /** Stale-merge confirmation envelope. When present, the queued events
   *  were NOT applied; the UI should prompt the user before retrying
   *  with `confirmMerge: true`. */
  needsConfirm?: {
    queuedCount: number
    serverEventsSince: number
    oldestQueuedTs: number
    newestServerTs: number
  }
}

/** Boot or recover the engine for `materialId`. IDB-first; falls back to
 *  `GET /api/sync/:materialId/state` on cache miss. Subsequent calls
 *  return the cached session.
 *
 *  `materialConfig` lets callers pass the user's year settings so the
 *  engine respects scope toggles (newScope, reviewScope, etc.). Omit
 *  to use `MaterialConfig::default()` — only safe before the user has
 *  touched settings; after that the wrong card set surfaces. */
export async function loadEngine(
  materialId: string,
  nowSecs: number,
  materialConfig?: WireMaterialConfig,
): Promise<EngineSession> {
  const existing = sessions.get(materialId)
  if (existing) return existing

  let snapshot = await idb.getSnapshot(materialId)
  let testStates: TestStateEntry[] = []

  if (snapshot) {
    testStates = await idb.getAllTestStates(materialId)
  } else {
    const fetched = await api.getSyncState(materialId)
    snapshot = {
      materialId,
      version: fetched.snapshot.version,
      materialData: fetched.snapshot.materialData,
      fetchedAt: nowSecs,
    }
    testStates = fetched.testStates
    await idb.putSnapshot(snapshot)
    await idb.replaceAllTestStates(materialId, testStates)
  }

  const engine = createEngine({
    materialData: snapshot.materialData,
    materialConfig: materialConfig ?? '',
    testStates,
    desiredRetention: DEFAULT_DESIRED_RETENTION,
    nowSecs,
  })

  const session: EngineSession = {
    materialId,
    engine,
    snapshotVersion: snapshot.version,
  }
  sessions.set(materialId, session)
  return session
}

/** Pull a fresh sync state from the server and replace local cache +
 *  engine. Used when the snapshot version has drifted or after a flush
 *  rebuild. Caller must already hold the session. */
async function refetchSyncState(session: EngineSession, nowSecs: number): Promise<void> {
  const fetched = await api.getSyncState(session.materialId)
  await idb.putSnapshot({
    materialId: session.materialId,
    version: fetched.snapshot.version,
    materialData: fetched.snapshot.materialData,
    fetchedAt: nowSecs,
  })
  await idb.replaceAllTestStates(session.materialId, fetched.testStates)
  // Snapshot version moved — invalidate the render cache wholesale; the
  // composed HTML the server emits depends on materialData structure.
  if (fetched.snapshot.version !== session.snapshotVersion) {
    await idb.clearRenders(session.materialId)
  }
  session.engine.free()
  session.engine = createEngine({
    materialData: fetched.snapshot.materialData,
    materialConfig: '', // refetch path mirrors the cached session's config

    testStates: fetched.testStates,
    desiredRetention: DEFAULT_DESIRED_RETENTION,
    nowSecs,
  })
  session.snapshotVersion = fetched.snapshot.version
}

/** Apply a review grade locally and queue the event for sync. Returns
 *  the engine's `TestUpdateWire[]` so callers can display per-test
 *  before/after immediately, without waiting on the network. */
export async function submitGrade(
  materialId: string,
  cardId: number,
  grade: Grade,
  nowSecs: number,
): Promise<TestUpdateWire[]> {
  const session = sessions.get(materialId)
  if (!session) throw new Error(`engineStore.submitGrade: no session for ${materialId}`)

  const updates = JSON.parse(
    session.engine.replay_event(cardId, grade, BigInt(nowSecs)),
  ) as TestUpdateWire[]

  await idb.appendQueuedEvent({
    materialId,
    kind: 'review',
    clientEventId: crypto.randomUUID(),
    timestampSecs: nowSecs,
    snapshotVersion: session.snapshotVersion,
    cardId,
    grade,
  })

  return updates
}

/** Apply a verse graduation locally and queue the event for sync.
 *  Returns the count of cards flipped New→Active. */
export async function submitGraduation(
  materialId: string,
  verseId: number,
  nowSecs: number,
): Promise<number> {
  const session = sessions.get(materialId)
  if (!session) throw new Error(`engineStore.submitGraduation: no session for ${materialId}`)

  const count = session.engine.graduate_verse(verseId)

  await idb.appendQueuedEvent({
    materialId,
    kind: 'graduate',
    clientEventId: crypto.randomUUID(),
    timestampSecs: nowSecs,
    snapshotVersion: session.snapshotVersion,
    verseId,
  })

  return count
}

/** Look up the next due review card. */
export function nextReviewCard(materialId: string, nowSecs: number): number | null {
  const session = sessions.get(materialId)
  if (!session) throw new Error(`engineStore.nextReviewCard: no session for ${materialId}`)
  const id = session.engine.next_review_card(BigInt(nowSecs))
  return id ?? null
}

/** Build a memorize session payload locally. The WASM engine returns
 *  a raw JSON array of `{ verseId, cardIds, recitationCardId }`; wrap
 *  it as `{ verses: [...] }` so the shape matches what the server's
 *  `/api/cards/memorize/session` route returns. Callers cast to
 *  `MemorizeSessionResponse`. */
export function memorizeSession(materialId: string, limit: number): unknown {
  const session = sessions.get(materialId)
  if (!session) throw new Error(`engineStore.memorizeSession: no session for ${materialId}`)
  const verses = JSON.parse(session.engine.memorize_session(limit))
  return { verses }
}

export function newCardCount(materialId: string): number {
  const session = sessions.get(materialId)
  if (!session) throw new Error(`engineStore.newCardCount: no session for ${materialId}`)
  return session.engine.new_card_count()
}

export function cardCountByClub(materialId: string): unknown {
  const session = sessions.get(materialId)
  if (!session) throw new Error(`engineStore.cardCountByClub: no session for ${materialId}`)
  return JSON.parse(session.engine.card_count_by_club())
}

/** Fetch a card's render — IDB cache first, network fallback. Stores
 *  the network result in IDB for offline replay. Honours the 30-day
 *  MAUA TTL via `getRender`'s freshness check. */
export async function getCardRender(
  materialId: string,
  cardId: number,
  nowSecs: number,
): Promise<CardRender> {
  const cached = await idb.getRender(materialId, cardId, nowSecs)
  if (cached) return cached.composed as CardRender

  const fresh = await api.getCardRender(materialId, cardId)
  await idb.putRender({
    materialId,
    cardId,
    composed: fresh,
    fetchedAt: nowSecs,
  })
  return fresh
}

/** Pending event count for the material — drives the "Syncing N…" UI
 *  affordance. */
export async function pendingCount(materialId: string): Promise<number> {
  return (await idb.getQueuedEvents(materialId)).length
}

/** Flush queued events. Coalesces concurrent calls so two near-simultaneous
 *  flushes share one round-trip and one event-deletion pass. */
export async function flush(materialId: string, nowSecs: number): Promise<FlushResult> {
  const existing = inflightFlushes.get(materialId)
  if (existing) return existing

  const promise = doFlush(materialId, nowSecs)
  inflightFlushes.set(materialId, promise)
  try {
    return await promise
  } finally {
    inflightFlushes.delete(materialId)
  }
}

async function doFlush(materialId: string, nowSecs: number): Promise<FlushResult> {
  const queued = await idb.getQueuedEvents(materialId)
  if (queued.length === 0) {
    return { accepted: 0, duplicates: 0, rebuilt: false }
  }
  const session = sessions.get(materialId)
  if (!session) throw new Error(`engineStore.flush: no session for ${materialId}`)

  const events = queued.map<SyncEventUpload>((q) => {
    if (q.kind === 'graduate') {
      return {
        kind: 'graduate',
        clientEventId: q.clientEventId,
        timestampSecs: q.timestampSecs,
        snapshotVersion: q.snapshotVersion,
        verseId: q.verseId,
      }
    }
    return {
      kind: 'review',
      clientEventId: q.clientEventId,
      timestampSecs: q.timestampSecs,
      snapshotVersion: q.snapshotVersion,
      cardId: q.cardId,
      grade: q.grade,
    }
  })

  let response: SyncEventsResponse
  try {
    response = await api.postSyncEvents(materialId, { events })
  } catch (err) {
    // 409 from snapshot mismatch is the one we can recover from
    // without user input: refetch /state, rebuild the engine, and
    // leave the events queued for the next flush to retry with the
    // upgraded snapshotVersion. Any other error propagates.
    const status = (err as { status?: number }).status
    if (status === 409) {
      await refetchSyncState(session, nowSecs)
      return { accepted: 0, duplicates: 0, rebuilt: false }
    }
    throw err
  }

  if ('needsConfirm' in response && response.needsConfirm) {
    return {
      accepted: 0,
      duplicates: 0,
      rebuilt: false,
      needsConfirm: response.staleSummary,
    }
  }

  // Non-needsConfirm path: response carries testStates + lastEventId.
  if (response.needsConfirm) {
    // Type narrowing — the union arm above already handled this.
    throw new Error('unreachable')
  }

  // Replace local testStates wholesale and rebuild the engine if the
  // server rebuilt. Otherwise just merge.
  await idb.replaceAllTestStates(materialId, response.testStates)
  if (response.rebuilt) {
    const snapshot = await idb.getSnapshot(materialId)
    if (snapshot) {
      session.engine.free()
      session.engine = createEngine({
        materialData: snapshot.materialData,
        materialConfig: '', // refetch path mirrors the cached session's config

        testStates: response.testStates,
        desiredRetention: DEFAULT_DESIRED_RETENTION,
        nowSecs,
      })
    }
  }

  await idb.deleteQueuedEvents(queued.map((q) => q.clientEventId))

  return {
    accepted: response.accepted,
    duplicates: response.duplicates,
    rebuilt: response.rebuilt,
  }
}

/** Drop the cached session — used after settings change or sign-out. */
export function invalidateSession(materialId: string): void {
  const session = sessions.get(materialId)
  if (session) {
    session.engine.free()
    sessions.delete(materialId)
  }
}

/** Test/dev helper: clear all in-memory state. Does not touch IDB. */
export function clearAllSessions(): void {
  for (const session of sessions.values()) session.engine.free()
  sessions.clear()
  inflightFlushes.clear()
}
