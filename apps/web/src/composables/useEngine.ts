/**
 * Vue composable wrapping `engineStore`. Provides a reactive session
 * surface for the views, plus background-flush plumbing so callers only
 * deal with synchronous-feeling local engine ops.
 *
 * Multi-material capable: `init(materialId)` may be called more than
 * once with different ids (MemorizeView spans every enrolled year in a
 * single session). All action methods take an explicit materialId so
 * the same composable instance can drive several engines side-by-side.
 * Listener cleanup + flushes operate over every initialised material.
 *
 * Behavioural contract:
 *   - On init: triggers `loadEngine(materialId)`, adds the id to the
 *     active set, kicks off a background flush to drain leftovers.
 *   - On every grade/graduation: caller awaits the action method, which
 *     applies locally and schedules a debounced flush across all
 *     active materials.
 *   - On `visibilitychange` (tab hide) and `beforeunload`: opportunistic
 *     flush across every active material so queued events don't leak
 *     across navigations.
 *
 * Stale-merge prompt: when any material's flush returns a `needsConfirm`
 * envelope, the composable stores it on `staleSummary` with the
 * material id. The view shows the modal and calls `confirmMerge()` or
 * `discardStale()` based on the user's choice. (Modal UI lands with the
 * SettingsView attribution work; the composable surface is in place now
 * so the wiring is clean.)
 */

import { onBeforeUnmount, ref, shallowRef } from 'vue'

import type { CardRender, Grade } from '../api'
import * as engineStore from '../lib/engine/engineStore'
import type { FlushResult } from '../lib/engine/engineStore'
import * as idb from '../lib/engine/persistence'
import type { WireMaterialConfig } from '../lib/engine/types'

/** Debounce window for the auto-flush trigger after a grade — long enough
 *  to coalesce a stream of grades into one round-trip, short enough that
 *  a casual session syncs within seconds. */
const FLUSH_DEBOUNCE_MS = 5_000

export interface StaleSummary {
  materialId: string
  queuedCount: number
  serverEventsSince: number
  oldestQueuedTs: number
  newestServerTs: number
}

export function useEngine() {
  const ready = ref(false)
  const error = shallowRef<unknown>(null)
  const syncing = ref(false)
  const pendingCount = ref(0)
  const orphanCount = ref(0)
  /** Set by `flushAll` when any active material returns `needsConfirm`.
   *  The view reads this to show the stale-merge confirmation modal. */
  const staleSummary = shallowRef<StaleSummary | null>(null)

  const active = new Set<string>()
  let debounceHandle: ReturnType<typeof setTimeout> | null = null

  function nowSecs(): number {
    return Math.floor(Date.now() / 1000)
  }

  async function refreshCounts() {
    // Parallel per-material so MemorizeView's ~8-year sessions don't
    // pay 16 serial IDB transactions after every grade. count() runs
    // against the index without materialising rows.
    const counts = await Promise.all(
      [...active].map(async (id) => {
        const [pending, orphans] = await Promise.all([
          engineStore.pendingCount(id),
          idb.countOrphans(id),
        ])
        return { pending, orphans }
      }),
    )
    pendingCount.value = counts.reduce((sum, c) => sum + c.pending, 0)
    orphanCount.value = counts.reduce((sum, c) => sum + c.orphans, 0)
  }

  async function flushOne(materialId: string): Promise<FlushResult> {
    const result = await engineStore.flush(materialId, nowSecs())
    if (result.needsConfirm) {
      staleSummary.value = { materialId, ...result.needsConfirm }
    }
    return result
  }

  async function flushAll(): Promise<void> {
    if (active.size === 0) return
    syncing.value = true
    try {
      // Parallel per-material: the server's per-(user, material) lock
      // serialises writes that actually collide, and different materials
      // never do. Engine-store coalesces same-material races to a single
      // round-trip already.
      const results = await Promise.all([...active].map(flushOne))
      if (!results.some((r) => r.needsConfirm)) staleSummary.value = null
    } catch (e) {
      error.value = e
      throw e
    } finally {
      syncing.value = false
      await refreshCounts()
    }
  }

  function scheduleFlush() {
    if (debounceHandle != null) clearTimeout(debounceHandle)
    debounceHandle = setTimeout(() => {
      debounceHandle = null
      void flushAll().catch(() => {
        // Errors are surfaced via `error`; swallow to keep the debounce loop alive.
      })
    }, FLUSH_DEBOUNCE_MS)
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      void flushAll().catch(() => {})
    }
  }
  function onBeforeUnload() {
    void flushAll().catch(() => {})
  }

  // Listeners are registered at setup time so onBeforeUnmount can clean
  // them up symmetrically. The expensive engine load is deferred to
  // init() so callers that need to resolve materialId asynchronously
  // (e.g. ReviewView picks the year via getYears()) can drive it.
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('beforeunload', onBeforeUnload)

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('beforeunload', onBeforeUnload)
    if (debounceHandle != null) clearTimeout(debounceHandle)
  })

  /** Boot the engine for the given material. Idempotent per id. Can be
   *  called multiple times for different materials in the same session
   *  (MemorizeView). `ready` flips true after the first successful
   *  init; the per-material flag is the membership in `active`.
   *
   *  Pass `config` to apply the user's year-settings (scope toggles,
   *  headings/ftv) when constructing the engine. Without it the engine
   *  uses the wasm-side fallback (all-clubs-enabled) — fine on a brand-
   *  new account, but surfaces the wrong card set after /settings is
   *  touched.
   *
   *  `schedule` is the per-(user, material) memorize schedule (bundled
   *  default or user override) — wasm@0.6.0's schedule-aware Phase 1 of
   *  the memorize fill reads it. Empty string skips it; behaviour
   *  collapses to pure-Sequential, matching pre-Phase-1. */
  async function init(id: string, config?: WireMaterialConfig, schedule: unknown | '' = '') {
    try {
      await engineStore.loadEngine(id, nowSecs(), config, schedule)
      active.add(id)
      await refreshCounts()
      ready.value = true
      // Drain any queue left over from a prior session for this
      // material. Backgrounded — don't block the UI on it.
      void flushOne(id).catch(() => {})
    } catch (e) {
      // Log alongside storing on `error.value`: not every caller renders
      // the ref, and a swallowed init failure cascades into misleading
      // downstream symptoms ("no session for <materialId>", spurious
      // fetch errors). Keep the real exception visible in the dev console.
      console.error(`useEngine.init: failed for ${id}`, e)
      error.value = e
    }
  }

  /** Drop the cached engine + render cache for one material — used
   *  after settings change so the next view trigger reloads the engine
   *  with fresh `MaterialConfig` and refetches renders that may
   *  reflect changed card visibility. */
  async function invalidate(id: string) {
    await engineStore.invalidateSession(id)
    active.delete(id)
  }

  /** Whether `init(id)` succeeded for this material. `init` swallows
   *  its own failures (surfacing them on `error`), so multi-material
   *  callers need this to tell a booted year from a failed one without
   *  probing engine calls for "no session" throws. */
  function isActive(id: string): boolean {
    return active.has(id)
  }

  // --- Public surface ---

  async function submitGrade(materialId: string, cardId: number, grade: Grade) {
    const updates = await engineStore.submitGrade(materialId, cardId, grade, nowSecs())
    await refreshCounts()
    scheduleFlush()
    return updates
  }

  async function submitGraduation(materialId: string, verseId: number) {
    const count = await engineStore.submitGraduation(materialId, verseId, nowSecs())
    await refreshCounts()
    scheduleFlush()
    return count
  }

  async function submitCardGraduation(materialId: string, cardId: number) {
    const flipped = await engineStore.submitCardGraduation(materialId, cardId, nowSecs())
    await refreshCounts()
    scheduleFlush()
    return flipped
  }

  function nextReviewCard(materialId: string): number | null {
    return engineStore.nextReviewCard(materialId, nowSecs())
  }

  function memorizeSession(materialId: string, limit: number) {
    return engineStore.memorizeSession(materialId, limit, nowSecs())
  }

  function newCardCount(materialId: string): number {
    return engineStore.newCardCount(materialId)
  }

  function cardCountByClub(materialId: string): engineStore.ClubCounts {
    return engineStore.cardCountByClub(materialId)
  }

  async function getCardRender(materialId: string, cardId: number): Promise<CardRender> {
    return engineStore.getCardRender(materialId, cardId, nowSecs())
  }

  /** Re-POST the affected material's queue with `confirmMerge: true`
   *  after the user approves the stale-merge modal. */
  async function confirmMerge() {
    const stale = staleSummary.value
    if (!stale) return
    staleSummary.value = null
    syncing.value = true
    try {
      await engineStore.flush(stale.materialId, nowSecs(), { confirmMerge: true })
    } catch (e) {
      error.value = e
      throw e
    } finally {
      syncing.value = false
      await refreshCounts()
    }
  }

  /** Dismiss the stale-merge prompt without acting on it. Clears the
   *  gate so the next flush re-surfaces the modal rather than
   *  silently no-op'ing. */
  function cancelStale() {
    const stale = staleSummary.value
    if (!stale) return
    engineStore.clearStaleGate(stale.materialId)
    staleSummary.value = null
  }

  /** Drop the queued events the server flagged stale on the affected
   *  material. The user explicitly chose to throw them away.
   *
   *  This must also drop the cached engine + snapshot, NOT just the
   *  event queue. Reasons:
   *    1. The cached in-memory engine still has `replay_event` mutations
   *       from every grade in the discarded batch, so its next-card
   *       picker would keep showing the post-grade view even though
   *       those grades are gone.
   *    2. Worse, `submitGraduation` / `submitCardGraduation` write to
   *       `snapshot.graduatedVerseIds` / `graduatedCardIds` via
   *       `persistLocalGraduation` *separately* from queuing the
   *       event. Discarding the queue rows leaves those lists with
   *       entries the server never received — and on the next page
   *       reload `loadEngine` re-applies them via `applyGraduations`,
   *       diverging the local engine from the server permanently.
   *
   *  `invalidateSession` drops the cached engine + render cache;
   *  `deleteSnapshot` drops the IDB snapshot so the next loadEngine
   *  cold-paths through `GET /state` and rebuilds from the server's
   *  authoritative view.
   */
  async function discardStale() {
    const stale = staleSummary.value
    if (!stale) return
    const queued = await idb.getQueuedEvents(stale.materialId)
    await idb.deleteQueuedEvents(queued.map((q) => q.clientEventId))
    // Re-open the flush path: the gate was set on the needsConfirm
    // response; without clearing it here, subsequent flushes would
    // continue to no-op even though there's nothing to confirm.
    engineStore.clearStaleGate(stale.materialId)
    await engineStore.invalidateSession(stale.materialId)
    await idb.deleteSnapshot(stale.materialId)
    staleSummary.value = null
    await refreshCounts()
    await engineStore.loadEngine(stale.materialId, nowSecs())
  }

  return {
    ready,
    error,
    syncing,
    pendingCount,
    orphanCount,
    staleSummary,
    init,
    invalidate,
    isActive,
    submitGrade,
    submitGraduation,
    submitCardGraduation,
    nextReviewCard,
    memorizeSession,
    newCardCount,
    cardCountByClub,
    getCardRender,
    flush: flushAll,
    confirmMerge,
    discardStale,
    cancelStale,
  }
}

export type EngineComposable = ReturnType<typeof useEngine>
