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
 * MaterialView attribution work; the composable surface is in place now
 * so the wiring is clean.)
 */

import { onBeforeUnmount, ref, shallowRef } from 'vue'

import type { CardRender, Grade } from '../api'
import * as engineStore from '../lib/engine/engineStore'
import type { FlushResult } from '../lib/engine/engineStore'
import * as idb from '../lib/engine/persistence'

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
    let pending = 0
    let orphans = 0
    for (const id of active) {
      pending += await engineStore.pendingCount(id)
      orphans += (await idb.getOrphans(id)).length
    }
    pendingCount.value = pending
    orphanCount.value = orphans
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
      // Sequential flushes — engineStore already coalesces per-material,
      // but going serial keeps the syncing UI affordance honest about
      // total work, and SQLite-backed servers like writes one user at a
      // time anyway.
      let anyConfirm = false
      for (const id of active) {
        const result = await flushOne(id)
        if (result.needsConfirm) anyConfirm = true
      }
      if (!anyConfirm) staleSummary.value = null
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
   *  init; the per-material flag is the membership in `active`. */
  async function init(id: string) {
    try {
      await engineStore.loadEngine(id, nowSecs())
      active.add(id)
      await refreshCounts()
      ready.value = true
      // Drain any queue left over from a prior session for this
      // material. Backgrounded — don't block the UI on it.
      void flushOne(id).catch(() => {})
    } catch (e) {
      error.value = e
    }
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

  function nextReviewCard(materialId: string): number | null {
    return engineStore.nextReviewCard(materialId, nowSecs())
  }

  function memorizeSession(materialId: string, limit: number): unknown {
    return engineStore.memorizeSession(materialId, limit)
  }

  function newCardCount(materialId: string): number {
    return engineStore.newCardCount(materialId)
  }

  function cardCountByClub(materialId: string): unknown {
    return engineStore.cardCountByClub(materialId)
  }

  async function getCardRender(materialId: string, cardId: number): Promise<CardRender> {
    return engineStore.getCardRender(materialId, cardId, nowSecs())
  }

  /** Re-POST the affected material's queue with `confirmMerge: true`
   *  after the user approves the stale-merge modal. Implementation
   *  pending — needs the engineStore.flush API to accept the
   *  confirmMerge flag; for now the queue stays put. */
  async function confirmMerge() {
    // TODO: re-flush with confirmMerge:true once engineStore exposes it.
    staleSummary.value = null
    return flushAll()
  }

  /** Drop the queued events the server flagged stale on the affected
   *  material. The user explicitly chose to throw them away. */
  async function discardStale() {
    const stale = staleSummary.value
    if (!stale) return
    const queued = await idb.getQueuedEvents(stale.materialId)
    await idb.deleteQueuedEvents(queued.map((q) => q.clientEventId))
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
    submitGrade,
    submitGraduation,
    nextReviewCard,
    memorizeSession,
    newCardCount,
    cardCountByClub,
    getCardRender,
    flush: flushAll,
    confirmMerge,
    discardStale,
  }
}

export type EngineComposable = ReturnType<typeof useEngine>
