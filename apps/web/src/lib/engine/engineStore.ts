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

interface EngineSession {
  materialId: string
  engine: WasmEngine
  snapshotVersion: number
  /** Cached so refetch + rebuild paths can re-pass it to `createEngine`
   *  without the caller having to reload year settings every time. */
  materialConfig: WireMaterialConfig | undefined
}

function requireSession(materialId: string, caller: string): EngineSession {
  const session = sessions.get(materialId)
  if (!session) throw new Error(`engineStore.${caller}: no session for ${materialId}`)
  return session
}

const sessions = new Map<string, EngineSession>()
const inflightFlushes = new Map<string, Promise<FlushResult>>()
/** Materials the server has flagged with a stale-merge `needsConfirm`.
 *  Flush calls for these no-op until either `confirmMerge: true` is
 *  passed (which bypasses the gate and clears it on success) or
 *  `clearStaleGate` is called explicitly (the discard path). Prevents
 *  the per-grade debounce + visibilitychange listeners from looping the
 *  same stale batch through the server endlessly. */
const staleGate = new Set<string>()

export function isStaleGated(materialId: string): boolean {
  return staleGate.has(materialId)
}

export function clearStaleGate(materialId: string): void {
  staleGate.delete(materialId)
}

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
      graduatedVerseIds: fetched.graduatedVerseIds,
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

  // Cards built from materialData default to `New`; flip each
  // graduated verse to `Active` so the in-memory engine matches
  // the persisted state. Mirrors `EngineStore.load` server-side.
  for (const verseId of snapshot.graduatedVerseIds ?? []) {
    engine.graduate_verse(verseId)
  }

  const session: EngineSession = {
    materialId,
    engine,
    snapshotVersion: snapshot.version,
    materialConfig,
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
    graduatedVerseIds: fetched.graduatedVerseIds,
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
    materialConfig: session.materialConfig ?? '',
    testStates: fetched.testStates,
    desiredRetention: DEFAULT_DESIRED_RETENTION,
    nowSecs,
  })
  for (const verseId of fetched.graduatedVerseIds) {
    session.engine.graduate_verse(verseId)
  }
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
  const session = requireSession(materialId, 'submitGrade')

  const updates = JSON.parse(
    session.engine.replay_event(cardId, grade, BigInt(nowSecs)),
  ) as TestUpdateWire[]

  // Fire-and-forget: the WASM call already updated the local engine
  // (the source of truth for the next-card pick), and a queued event
  // lost to a crash mid-write will be recomputed from server state on
  // next session. Awaiting the IDB write here would block every grade
  // on a tx round-trip for no correctness gain.
  void idb
    .appendQueuedEvent({
      materialId,
      kind: 'review',
      clientEventId: crypto.randomUUID(),
      timestampSecs: nowSecs,
      snapshotVersion: session.snapshotVersion,
      cardId,
      grade,
    })
    .catch((e) => {
      console.warn('engineStore.submitGrade: queue append failed', e)
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
  const session = requireSession(materialId, 'submitGraduation')
  const count = session.engine.graduate_verse(verseId)

  void idb
    .appendQueuedEvent({
      materialId,
      kind: 'graduate',
      clientEventId: crypto.randomUUID(),
      timestampSecs: nowSecs,
      snapshotVersion: session.snapshotVersion,
      verseId,
    })
    .catch((e) => {
      console.warn('engineStore.submitGraduation: queue append failed', e)
    })

  // Persist the graduation locally too so a page reload before the
  // event flushes (or after it flushes but before /state is re-fetched)
  // still resurrects the verse as Active.
  void persistLocalGraduation(materialId, verseId).catch((e) => {
    console.warn('engineStore.submitGraduation: snapshot update failed', e)
  })

  return count
}

async function persistLocalGraduation(materialId: string, verseId: number): Promise<void> {
  const snapshot = await idb.getSnapshot(materialId)
  if (!snapshot) return
  const ids = snapshot.graduatedVerseIds ?? []
  if (ids.includes(verseId)) return
  await idb.putSnapshot({ ...snapshot, graduatedVerseIds: [...ids, verseId] })
}

/** Look up the next due review card. */
export function nextReviewCard(materialId: string, nowSecs: number): number | null {
  const session = requireSession(materialId, 'nextReviewCard')
  const id = session.engine.next_review_card(BigInt(nowSecs))
  return id ?? null
}

interface MemorizeSessionEntry {
  verseId: number
  cardIds: number[]
  recitationCardId: number | null
}

/** Build a memorize session payload locally. The WASM engine returns
 *  a raw JSON array of `{ verseId, cardIds, recitationCardId }`; wrap
 *  it as `{ verses: [...] }` so the shape matches what the server's
 *  `/api/cards/memorize/session` route returns. */
export function memorizeSession(
  materialId: string,
  limit: number,
): { verses: MemorizeSessionEntry[] } {
  const session = requireSession(materialId, 'memorizeSession')
  return { verses: JSON.parse(session.engine.memorize_session(limit)) }
}

export function newCardCount(materialId: string): number {
  return requireSession(materialId, 'newCardCount').engine.new_card_count()
}

export interface ClubCounts {
  Club150: number
  Club300: number
  Full: number
}

export function cardCountByClub(materialId: string): ClubCounts {
  const session = requireSession(materialId, 'cardCountByClub')
  return JSON.parse(session.engine.card_count_by_club()) as ClubCounts
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
  // Skip the cache write when the server returned no composed HTML
  // (BIBLE_API_KEY unset on the server — see apps/web/src/api.ts).
  // Caching the null would mean the client returns it for 30 days even
  // after the operator sets the key, hiding recovery until the
  // snapshotVersion bump invalidates renders.
  if (fresh.composed !== null) {
    await idb.putRender({
      materialId,
      cardId,
      composed: fresh,
      fetchedAt: nowSecs,
    })
  }
  return fresh
}

/** Pending event count for the material — drives the "Syncing N…" UI
 *  affordance. Uses IDB `count()` so we don't materialise rows the
 *  caller is going to discard. */
export async function pendingCount(materialId: string): Promise<number> {
  return idb.countQueuedEvents(materialId)
}

/** Flush queued events. Coalesces concurrent calls so two near-simultaneous
 *  flushes share one round-trip and one event-deletion pass.
 *
 *  `opts.confirmMerge` bypasses the server's stale-merge preflight —
 *  set after the user clicks Sync on the confirmation modal. */
export async function flush(
  materialId: string,
  nowSecs: number,
  opts: { confirmMerge?: boolean } = {},
): Promise<FlushResult> {
  // Don't keep re-POSTing a batch the server already told us needs
  // user confirmation. confirmMerge:true is the explicit override that
  // resumes flushing (and clears the gate on success).
  if (!opts.confirmMerge && staleGate.has(materialId)) {
    return { accepted: 0, duplicates: 0, rebuilt: false }
  }
  const existing = inflightFlushes.get(materialId)
  if (existing) return existing

  const promise = doFlush(materialId, nowSecs, opts.confirmMerge ?? false)
  inflightFlushes.set(materialId, promise)
  try {
    return await promise
  } finally {
    inflightFlushes.delete(materialId)
  }
}

async function doFlush(
  materialId: string,
  nowSecs: number,
  confirmMerge: boolean,
): Promise<FlushResult> {
  const queued = await idb.getQueuedEvents(materialId)
  if (queued.length === 0) {
    return { accepted: 0, duplicates: 0, rebuilt: false }
  }
  const session = requireSession(materialId, 'flush')

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
    response = await api.postSyncEvents(materialId, { events, confirmMerge })
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
    staleGate.add(materialId)
    return {
      accepted: 0,
      duplicates: 0,
      rebuilt: false,
      needsConfirm: response.staleSummary,
    }
  }
  // The union narrows here: the `needsConfirm` arm returned above, so
  // the rest of this function sees only the merged-response shape.
  // Successful merge — clear the gate (covers the confirmMerge:true
  // retry path and the case where prior server activity drained below
  // the stale-merge threshold).
  staleGate.delete(materialId)

  await idb.replaceAllTestStates(materialId, response.testStates)
  if (response.rebuilt) {
    const snapshot = await idb.getSnapshot(materialId)
    if (snapshot) {
      session.engine.free()
      session.engine = createEngine({
        materialData: snapshot.materialData,
        materialConfig: session.materialConfig ?? '',
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

/** Drop the cached session + render cache — used after settings
 *  change or sign-out. Stale composed HTML is always wrong once
 *  scope toggles flip card visibility, so we don't make callers
 *  remember to clear it separately. */
export async function invalidateSession(materialId: string): Promise<void> {
  const session = sessions.get(materialId)
  if (session) {
    session.engine.free()
    sessions.delete(materialId)
  }
  await idb.clearRenders(materialId)
}

/** Test/dev helper: clear all in-memory state. Does not touch IDB. */
export function clearAllSessions(): void {
  for (const session of sessions.values()) session.engine.free()
  sessions.clear()
  inflightFlushes.clear()
}
