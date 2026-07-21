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
 * Also the multi-year boot orchestrator: `initEligibleYears` fetches the
 * user's years (`api`), filters eligibility (`lib/clubs`), and boots each
 * with its per-club config + schedule (`lib/badges`' shared cache) — the
 * shape ReviewView and MemorizeView both drive their sessions from.
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
 * Stale-merge prompt: engineStore's stale gate owns which materials are
 * awaiting confirmation (with their summaries, in arrival order); the
 * composable projects `staleSummary` off its head after each flush and
 * the view shows the modal, calling `confirmMerge()` / `discardStale()` /
 * `cancelStale()` on the user's choice. Multiple simultaneously-stale
 * materials queue and surface one at a time.
 */

import { onBeforeUnmount, ref, shallowRef } from 'vue'

import { api, type CardRender, type Grade, type YearView } from '../api'
import { getCachedSchedule, getCachedYears } from '../lib/apiCache'
import { hasEnabledClub } from '../lib/clubs'
import * as engineStore from '../lib/engine/engineStore'
import type { FlushResult } from '../lib/engine/engineStore'
import * as idb from '../lib/engine/persistence'
import type { WireMaterialConfig } from '../lib/engine/types'

/** Debounce window for the auto-flush trigger after a grade — long enough
 *  to coalesce a stream of grades into one round-trip, short enough that
 *  a casual session syncs within seconds. */
const FLUSH_DEBOUNCE_MS = 5_000

/** The stale-merge prompt shape the view binds to. Owned by engineStore
 *  (its stale gate is the single source of truth); re-exported here so
 *  the view keeps importing it from the composable. */
export type StaleSummary = engineStore.StalePrompt

export function useEngine() {
  const ready = ref(false)
  const error = shallowRef<unknown>(null)
  const syncing = ref(false)
  const pendingCount = ref(0)
  const orphanCount = ref(0)
  /** The stale-merge prompt currently shown to the user — the head of
   *  engineStore's stale gate, which owns membership + payload + arrival
   *  order (#119). A pull projection: refreshed after every flush /
   *  confirm / discard, so when two materials go stale in one flush both
   *  stay queued and surface one at a time (#112). It self-heals rather
   *  than staying live — a gate reset the composable doesn't drive
   *  (`clearAllSessions` on profile switch) isn't reflected until the next
   *  `refreshStale`, but every resolution path ends in one, so the modal
   *  is reconciled on the next action or on unmount, never permanently
   *  stranded. */
  const staleSummary = shallowRef<StaleSummary | null>(null)

  /** Re-project `staleSummary` from the head of engineStore's stale gate.
   *  Returns the gate's own stored object, so re-projecting after an
   *  unrelated material's flush yields the same reference and doesn't
   *  churn the modal. */
  function refreshStale() {
    staleSummary.value = engineStore.firstStalePrompt()
  }

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
    // engineStore's flush maintains the gate itself (sets it on a
    // needsConfirm response, clears it on a clean merge), so a still-gated
    // material stays queued and a resolved one drops — we just re-project
    // the modal off the gate head afterward.
    const result = await engineStore.flush(materialId, nowSecs())
    refreshStale()
    return result
  }

  async function flushAll(): Promise<void> {
    if (active.size === 0) return
    syncing.value = true
    try {
      // Parallel per-material: the server's per-(user, material) lock
      // serialises writes that actually collide, and different materials
      // never do. Engine-store coalesces same-material races to a single
      // round-trip already. staleSummary is kept in sync by flushOne.
      await Promise.all([...active].map(flushOne))
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

  /** Fetch every year, keep the enrolled ones with an enabled tier in
   *  `perClub[club]` (plus an optional `extra` predicate — e.g.
   *  MemorizeView's `newCardCount > 0`), and boot each in parallel with
   *  its per-club config + schedule. The schedule rides the engine ctor
   *  so a later visit to the other tab reuses it via the session cache;
   *  fetches route through the shared schedule cache so the same
   *  navigation's badge doesn't refetch. A failed schedule fetch degrades
   *  that one year to no-schedule (pure-Sequential) rather than wedging
   *  the whole multi-year boot.
   *
   *  Returns the eligible years in request order. `init` swallows its own
   *  failures, so callers that must exclude a year that failed to boot
   *  filter the result by `isActive(materialId)`.
   *
   *  Reading `perClub[club]` (not the legacy flat `reviewScope`/`newScope`)
   *  matches what the engine actually gates on — the flat settings are a
   *  derived mirror authoritative only for pre-Phase-1 rows. */
  async function initEligibleYears(
    club: 'review' | 'memorize',
    extra?: (year: YearView) => boolean,
  ): Promise<YearView[]> {
    const res = await getCachedYears(api.getYears)
    const eligible = res.years.filter(
      (y) => y.enrolled && hasEnabledClub(y.perClub[club]) && (extra?.(y) ?? true),
    )
    await Promise.all(
      eligible.map(async (y) => {
        const schedule = await getCachedSchedule(y.materialId, api.getSchedule).catch(() => null)
        await init(y.materialId, y.perClub, schedule ?? '')
      }),
    )
    return eligible
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
    syncing.value = true
    try {
      await engineStore.flush(stale.materialId, nowSecs(), { confirmMerge: true })
    } catch (e) {
      error.value = e
      throw e
    } finally {
      // engineStore clears the gate on a clean merge and keeps it on a
      // throw or a re-issued needsConfirm, so re-projecting the head here
      // promotes the next prompt on success and leaves this one up
      // otherwise — no #112 wedge, no manual reconciliation.
      syncing.value = false
      refreshStale()
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
    refreshStale()
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
    // Capture the live session's config + schedule BEFORE invalidating —
    // the reload below must re-pass them, or the rebuilt engine falls back
    // to the wasm-side all-clubs-enabled-at-legacy-retention default and
    // serves cards from disabled clubs at the wrong retention for the rest
    // of the session (the hazard loadEngine documents).
    const cached = engineStore.sessionConfig(stale.materialId)
    const queued = await idb.getQueuedEvents(stale.materialId)
    await idb.deleteQueuedEvents(queued.map((q) => q.clientEventId))
    // Re-open the flush path: the gate was set on the needsConfirm
    // response; without clearing it here, subsequent flushes would
    // continue to no-op even though there's nothing to confirm.
    engineStore.clearStaleGate(stale.materialId)
    await engineStore.invalidateSession(stale.materialId)
    await idb.deleteSnapshot(stale.materialId)
    refreshStale()
    await refreshCounts()
    await engineStore.loadEngine(
      stale.materialId,
      nowSecs(),
      cached?.materialConfig,
      cached?.schedule ?? '',
    )
  }

  return {
    ready,
    error,
    syncing,
    pendingCount,
    orphanCount,
    staleSummary,
    init,
    initEligibleYears,
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
