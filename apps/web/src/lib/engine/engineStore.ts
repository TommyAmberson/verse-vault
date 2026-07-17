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

// Per-club retention now lives inside MaterialConfig (wasm@0.6.0).
// Schedules are optional per material — empty string skips the
// schedule-aware Phase 1 of the memorize fill, matching the legacy
// pre-Phase-1 behaviour for decks that don't ship one.

interface EngineSession {
  materialId: string
  engine: WasmEngine
  snapshotVersion: number
  /** Cached so refetch + rebuild paths can re-pass it to `createEngine`
   *  without the caller having to reload year settings every time. */
  materialConfig: WireMaterialConfig | undefined
  /** Per-(user, material) schedule override or bundled default, cached
   *  for the same reason as `materialConfig` — refetch + rebuild paths
   *  rebuild the engine and need to re-pass it. Empty string when no
   *  schedule applies (memorize collapses to pure-Sequential). */
  schedule: unknown | ''
}

function requireSession(materialId: string, caller: string): EngineSession {
  const session = sessions.get(materialId)
  if (!session) throw new Error(`engineStore.${caller}: no session for ${materialId}`)
  return session
}

const sessions = new Map<string, EngineSession>()
const inflightFlushes = new Map<string, Promise<FlushResult>>()
/** Per-(materialId) coalescing for `loadEngine`, mirroring
 *  `inflightFlushes`. `loadEngine` is check-then-set across several
 *  awaits (IDB read, `GET /state`, `createEngine`); two concurrent calls
 *  for the same material — e.g. navigating /memorize → /review while the
 *  first init is still in flight — would both miss the `sessions.get`
 *  check, build two `WasmEngine`s, and the second `sessions.set` would
 *  orphan the first without `.free()`ing it (leaked Rust linear memory).
 *  Concurrent callers await the same `Promise<EngineSession>` instead. */
const inflightLoads = new Map<string, Promise<EngineSession>>()
/** Per-(materialId) serialisation chain for `persistLocalGraduation`. The
 *  snapshot read-modify-write window in `persistLocalGraduation` runs as
 *  two separate IDB operations, so concurrent fire-and-forget calls (e.g.
 *  `MemorizeView`'s `Promise.all([submitGraduation, ...submitCardGraduation])`)
 *  would each see the same pre-mutation snapshot and overwrite each
 *  other's ids. Chaining onto the previous promise serialises them. */
const persistGraduationChains = new Map<string, Promise<void>>()
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

/** The `materialConfig` + `schedule` a live session was built with, or
 *  `undefined` if no session is cached. Rebuild paths that drop and
 *  reload a session (e.g. `useEngine.discardStale`) read this *before*
 *  invalidating so the reload preserves per-club enables + retention +
 *  schedule instead of falling back to the wasm-side all-clubs-enabled
 *  default (see `loadEngine`'s `materialConfig` note). */
export function sessionConfig(
  materialId: string,
): { materialConfig: WireMaterialConfig | undefined; schedule: unknown | '' } | undefined {
  const session = sessions.get(materialId)
  if (!session) return undefined
  return { materialConfig: session.materialConfig, schedule: session.schedule }
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
 *  engine respects per-club enables, retention, and gates. Omit to use
 *  the wasm-side fallback (all-clubs-enabled at the legacy retention)
 *  — only safe before the user has touched settings; after that the
 *  wrong card set surfaces.
 *
 *  `schedule` is the per-(user, material) memorize schedule (bundled
 *  default or user override). Empty string skips schedule-aware Phase 1
 *  of the memorize fill — pure-Sequential behaviour. */
export async function loadEngine(
  materialId: string,
  nowSecs: number,
  materialConfig?: WireMaterialConfig,
  schedule: unknown | '' = '',
): Promise<EngineSession> {
  const existing = sessions.get(materialId)
  if (existing) return existing
  const inflight = inflightLoads.get(materialId)
  if (inflight) return inflight

  const promise = buildSession(materialId, nowSecs, materialConfig, schedule)
  inflightLoads.set(materialId, promise)
  try {
    return await promise
  } finally {
    inflightLoads.delete(materialId)
  }
}

async function buildSession(
  materialId: string,
  nowSecs: number,
  materialConfig: WireMaterialConfig | undefined,
  schedule: unknown | '',
): Promise<EngineSession> {
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
      graduatedCardIds: fetched.graduatedCardIds,
    }
    testStates = fetched.testStates
    await idb.putSnapshot(snapshot)
    await idb.replaceAllTestStates(materialId, testStates)
  }

  const engine = createEngine({
    materialData: snapshot.materialData,
    materialConfig: materialConfig ?? '',
    schedule,
    testStates,
    nowSecs,
  })
  applyGraduations(engine, snapshot.graduatedVerseIds, snapshot.graduatedCardIds)

  const session: EngineSession = {
    materialId,
    engine,
    snapshotVersion: snapshot.version,
    materialConfig,
    schedule,
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
    graduatedCardIds: fetched.graduatedCardIds,
  })
  await idb.replaceAllTestStates(session.materialId, fetched.testStates)
  // Snapshot version moved — invalidate the render cache wholesale; the
  // composed HTML the server emits depends on materialData structure.
  if (fetched.snapshot.version !== session.snapshotVersion) {
    await idb.clearRenders(session.materialId)
  }
  // Build the replacement engine BEFORE freeing the old one — a
  // free-then-create order leaves `session.engine` pointing at a
  // dead Rust struct if `WasmEngine::new` throws (mismatched
  // contract version, malformed materialData, etc.), and the next
  // requireSession-driven call would trap dereferencing it. Build
  // first → swap atomically → free the old engine only on success.
  const replacement = createEngine({
    materialData: fetched.snapshot.materialData,
    materialConfig: session.materialConfig ?? '',
    schedule: session.schedule,
    testStates: fetched.testStates,
    nowSecs,
  })
  const previous = session.engine
  session.engine = replacement
  previous.free()
  applyGraduations(session.engine, fetched.graduatedVerseIds, fetched.graduatedCardIds)
  session.snapshotVersion = fetched.snapshot.version
}

/** Replay the user's graduation log onto a freshly-built engine so its
 *  card state matches what `EngineStore.load` produces server-side. */
function applyGraduations(
  engine: WasmEngine,
  verseIds: number[] | undefined,
  cardIds: number[] | undefined,
): void {
  for (const id of verseIds ?? []) engine.graduate_verse(id)
  for (const id of cardIds ?? []) engine.graduate_card(id)
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
  void persistLocalGraduation(materialId, 'graduatedVerseIds', verseId).catch((e) => {
    console.warn('engineStore.submitGraduation: snapshot update failed', e)
  })

  return count
}

// Caller (`submitGraduation` / `submitCardGraduation`) already validated
// a live session via `requireSession`, and sessions imply a snapshot row
// in IDB — `getSnapshot` is treated as infallible here. A missing row
// signals genuine IDB corruption and propagates as a thrown error
// through the surrounding fire-and-forget `.catch`.
//
// Concurrent calls are serialised via `persistGraduationChains` so the
// read-modify-write of `graduatedVerseIds` / `graduatedCardIds` is
// race-free. Without serialisation, MemorizeView's
// `Promise.all([submitGraduation, ...conditionalCardIds.map(submitCardGraduation)])`
// would have every call read the same pre-mutation snapshot and
// overwrite each other's ids — silently dropping graduations that
// then revert to `New` on the next page load.
async function persistLocalGraduation(
  materialId: string,
  field: 'graduatedVerseIds' | 'graduatedCardIds',
  id: number,
): Promise<void> {
  const prev = persistGraduationChains.get(materialId) ?? Promise.resolve()
  const next = prev.then(async () => {
    const snapshot = (await idb.getSnapshot(materialId))!
    const ids = snapshot[field] ?? []
    if (ids.includes(id)) return
    await idb.putSnapshot({ ...snapshot, [field]: [...ids, id] })
  })
  // Swallow the chained promise's rejection so a single failed write
  // doesn't poison every subsequent write on the same material — the
  // failure still surfaces through the returned `next` to the original
  // caller's `.catch`.
  persistGraduationChains.set(
    materialId,
    next.catch(() => {}),
  )
  return next
}

/** Apply a single-card graduation locally and queue the event for
 *  sync. Returns whether the card transitioned `New → Active` (false
 *  on already-Active or unknown card). */
export async function submitCardGraduation(
  materialId: string,
  cardId: number,
  nowSecs: number,
): Promise<boolean> {
  const session = requireSession(materialId, 'submitCardGraduation')
  const flipped = session.engine.graduate_card(cardId)

  void idb
    .appendQueuedEvent({
      materialId,
      kind: 'graduateCard',
      clientEventId: crypto.randomUUID(),
      timestampSecs: nowSecs,
      snapshotVersion: session.snapshotVersion,
      cardId,
    })
    .catch((e) => {
      console.warn('engineStore.submitCardGraduation: queue append failed', e)
    })

  void persistLocalGraduation(materialId, 'graduatedCardIds', cardId).catch((e) => {
    console.warn('engineStore.submitCardGraduation: snapshot update failed', e)
  })

  return flipped
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
  conditionalCardIds?: number[]
  recitationCardId: number | null
  hpCardId?: number
  cclCardId?: number
}

/** Build a memorize session payload locally. Mirrors the server's
 *  `/api/cards/memorize/session` route. See `MemorizeSessionResponse`
 *  in `@/api` for field semantics.
 *
 *  Uses wasm@0.6.0's `memorize_session_v2(limit, now_secs)` — the
 *  schedule-aware two-phase canonical-order fill. Falls back to pure-
 *  Sequential when no schedule was passed to the engine constructor,
 *  matching pre-Phase-1 behaviour for decks without a schedule. */
export function memorizeSession(
  materialId: string,
  limit: number,
  nowSecs: number,
): { verses: MemorizeSessionEntry[]; orphans: number[] } {
  const session = requireSession(materialId, 'memorizeSession')
  const parsed = JSON.parse(session.engine.memorize_session_v2(limit, BigInt(nowSecs))) as {
    verses: MemorizeSessionEntry[]
    orphans?: number[]
  }
  return { verses: parsed.verses, orphans: parsed.orphans ?? [] }
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
    if (q.kind === 'graduateCard') {
      return {
        kind: 'graduateCard',
        clientEventId: q.clientEventId,
        timestampSecs: q.timestampSecs,
        snapshotVersion: q.snapshotVersion,
        cardId: q.cardId,
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
    // without user input: refetch /state, rebuild the engine, then
    // re-stamp every queued event with the new snapshot version so
    // the next flush passes the server's per-event check. Without
    // the re-stamp the queued rows keep their original snapshot
    // version, every retry 409s on the same rows, and the queue
    // wedges forever. Any other error propagates.
    const status = (err as { status?: number }).status
    if (status === 409) {
      await refetchSyncState(session, nowSecs)
      await idb.rewriteQueuedSnapshotVersion(materialId, session.snapshotVersion)
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
      // Build → swap → free, same as refetchSyncState. createEngine
      // throwing (e.g. mismatched contract version after a server-
      // bumped snapshot) must not leave session.engine pointing at
      // a freed Rust struct.
      const replacement = createEngine({
        materialData: snapshot.materialData,
        materialConfig: session.materialConfig ?? '',
        schedule: session.schedule,
        testStates: response.testStates,
        nowSecs,
      })
      const previous = session.engine
      session.engine = replacement
      previous.free()
      // The fresh engine has no graduation history — without re-
      // applying the locally-persisted graduated{Verse,Card}Ids,
      // graduated verses leak back into the New pool, memorize_session
      // re-introduces them, and next-card selection ignores prior
      // graduations until a full page reload re-enters `loadEngine`.
      // `loadEngine` and `refetchSyncState` both apply graduations
      // after `createEngine`; this path was missing the same step.
      applyGraduations(session.engine, snapshot.graduatedVerseIds, snapshot.graduatedCardIds)
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

/** Reset all per-profile in-memory state. Frees every cached WASM
 *  engine and drops the sessions / inflightFlushes / staleGate /
 *  persistGraduationChains maps. Called on profile switch + sign-out
 *  (`useAuth.signInComplete`, `useAuth.enterProfile`, `useAuth.signOut`)
 *  so the next profile starts fresh — without clearing `staleGate`, a
 *  stale-merge gate from profile A would silently no-op every flush
 *  in profile B (or the same user's next session). Does not touch IDB.
 *
 *  **Asynchronous and must be awaited.** Any in-flight flush, engine
 *  load (cold path writes the fetched snapshot + testStates), or
 *  graduation persist runs `await idb.<op>(materialId, ...)` against
 *  `openDb()`, which reads the global active profile id. If the
 *  caller swaps the active profile (`setActiveProfile(B)`) before
 *  awaiting these promises, the response handler resolves AFTER the
 *  swap and writes profile A's testStates / graduations into profile
 *  B's IDB — a concrete cross-profile data leak. The wait drains
 *  outstanding writes against the still-current profile A's IDB
 *  before clearing the maps. */
export async function clearAllSessions(): Promise<void> {
  // Snapshot the promises before clearing the maps so the awaited
  // settle() doesn't race with new entries appearing in either map.
  const pending: Promise<unknown>[] = [
    ...inflightFlushes.values(),
    ...inflightLoads.values(),
    ...persistGraduationChains.values(),
  ]
  // Drain — allSettled because a single failure shouldn't block the
  // others or throw out of clearAllSessions. Callers expect this to
  // succeed even when one of the in-flight ops rejects.
  if (pending.length > 0) {
    await Promise.allSettled(pending)
  }
  for (const session of sessions.values()) session.engine.free()
  sessions.clear()
  inflightFlushes.clear()
  inflightLoads.clear()
  staleGate.clear()
  persistGraduationChains.clear()
}
