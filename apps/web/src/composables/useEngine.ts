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
 * with its per-club config + schedule (`lib/apiCache`'s shared caches) —
 * the shape ReviewView and MemorizeView both drive their sessions from.
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
 * Stale-merge prompt: the question and the batch it concerns live on the
 * server. engineStore's prompt queue holds the questions it has heard of
 * (from an upload, a cold state fetch, or the years row), in arrival
 * order; the composable projects `staleSummary` off its head and the
 * view shows the modal, calling `confirmMerge()` / `discardStale()` /
 * `cancelStale()` on the user's choice. Multiple simultaneously-stale
 * materials queue and surface one at a time.
 */

import { onBeforeUnmount, ref, shallowRef } from 'vue'

import { api, type CardRender, type Grade, type YearView } from '../api'
import { getCachedSchedule, getCachedYears } from '../lib/apiCache'
import { hasEnabledClub, hasReviewableClub } from '../lib/clubs'
import * as engineStore from '../lib/engine/engineStore'
import type { FlushResult } from '../lib/engine/engineStore'
import type { StaleMergeSummary, WireMaterialConfig } from '../lib/engine/types'

/** Debounce window for the auto-flush trigger after a grade — long enough
 *  to coalesce a stream of grades into one round-trip, short enough that
 *  a casual session syncs within seconds. */
const FLUSH_DEBOUNCE_MS = 5_000

/** The stale-merge prompt shape the view binds to. Owned by engineStore
 *  (its prompt queue is the single source of truth); re-exported here so
 *  the view keeps importing it from the composable. */
export type StaleSummary = engineStore.StalePrompt

export function useEngine() {
  const ready = ref(false)
  const error = shallowRef<unknown>(null)
  const syncing = ref(false)
  const pendingCount = ref(0)
  /** The stale-merge prompt currently shown to the user — the head of
   *  engineStore's prompt queue, which owns membership + payload + arrival
   *  order (#119). A pull projection: refreshed after every flush /
   *  confirm / discard, so when two materials go stale in one flush both
   *  stay queued and surface one at a time (#112). It self-heals rather
   *  than staying live — a gate reset the composable doesn't drive
   *  (`clearAllSessions` on profile switch) isn't reflected until the next
   *  `refreshStale`, but every resolution path ends in one, so the modal
   *  is reconciled on the next action or on unmount, never permanently
   *  stranded. */
  const staleSummary = shallowRef<StaleSummary | null>(null)

  /** Re-project `staleSummary` from the head of engineStore's prompt queue.
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
    // Parallel per-material so MemorizeView's ~8-year sessions don't pay
    // serial IDB transactions after every grade. count() runs against the
    // index without materialising rows.
    const counts = await Promise.all([...active].map((id) => engineStore.pendingCount(id)))
    pendingCount.value = counts.reduce((sum, c) => sum + c, 0)
  }

  async function flushOne(materialId: string): Promise<FlushResult> {
    // engineStore's flush raises a question on a needsConfirm response
    // itself, so we just re-project the modal off the queue head after.
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
   *  collapses to pure-Sequential, matching pre-Phase-1.
   *
   *  `stateRev` is the server's state fingerprint from the years row —
   *  see `engineStore.loadEngine`. Omit when unknown; the cached
   *  snapshot is then trusted unconditionally.
   *
   *  `pendingConfirmation` is the years row's open merge question, the
   *  only way a device booting from its cache hears of one raised by
   *  another device. Omit when unknown. */
  async function init(
    id: string,
    config?: WireMaterialConfig,
    schedule: unknown | '' = '',
    stateRev?: string,
    pendingConfirmation?: StaleMergeSummary | null,
  ) {
    try {
      await engineStore.loadEngine(id, nowSecs(), config, schedule, stateRev)
      engineStore.setMergeQuestion(id, pendingConfirmation)
      refreshStale()
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
   *  Reading `perClub` (not the legacy flat `reviewScope`/`newScope`)
   *  matches what the engine actually gates on — the flat settings are a
   *  derived mirror authoritative only for pre-Phase-1 rows.
   *
   *  Memorize wants `memorize.{tier}.enabled` — the switch for introducing
   *  new verses. Review wants the wider "not Paused" test on the payload's
   *  own per-tier status, because that is what decides whether cards exist
   *  at all: `builder.rs` emits nothing for a paused tier, and treats
   *  memorize-only as Active. */
  async function initEligibleYears(
    club: 'review' | 'memorize',
    extra?: (year: YearView) => boolean,
  ): Promise<YearView[]> {
    const res = await getCachedYears(api.getYears)
    const covers = (y: YearView) =>
      club === 'review' ? hasReviewableClub(y.clubs) : hasEnabledClub(y.perClub.memorize)
    const eligible = res.years.filter((y) => y.enrolled && covers(y) && (extra?.(y) ?? true))
    await Promise.all(
      eligible.map(async (y) => {
        const schedule = await getCachedSchedule(y.materialId, api.getSchedule).catch(() => null)
        await init(y.materialId, y.perClub, schedule ?? '', y.stateRev, y.pendingConfirmation)
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

  /** Answer the open question on the modal. The batch is already on the
   *  server; this tells it what to do with it, then rebuilds the local
   *  engine from the result. */
  async function answerStale(decision: 'merge' | 'discard') {
    const stale = staleSummary.value
    if (!stale) return
    syncing.value = true
    try {
      await engineStore.answerMergeQuestion(stale.materialId, decision, nowSecs())
    } catch (e) {
      error.value = e
      throw e
    } finally {
      // A failed answer leaves the question queued, so re-projecting
      // keeps the modal up on failure and promotes the next on success.
      syncing.value = false
      refreshStale()
      await refreshCounts()
    }
  }

  /** Merge the held batch at its recorded times. */
  function confirmMerge() {
    return answerStale('merge')
  }

  /** Set the held batch aside. It is kept on the server, marked
   *  discarded, rather than deleted. */
  function discardStale() {
    return answerStale('discard')
  }

  /** Dismiss the prompt without answering. The question stays open on
   *  the server and comes back on the next boot. */
  function cancelStale() {
    const stale = staleSummary.value
    if (!stale) return
    engineStore.dismissMergeQuestion(stale.materialId)
    refreshStale()
  }

  return {
    ready,
    error,
    syncing,
    pendingCount,
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
