/**
 * Vue composable wrapping `engineStore`. Provides a reactive session
 * surface for the views, plus background-flush plumbing so callers only
 * deal with synchronous-feeling local engine ops.
 *
 * Use one composable instance per view that needs the engine; the
 * underlying session is shared across all callers for the same
 * materialId (engineStore is a module singleton).
 *
 * Behavioural contract:
 *   - On first mount: triggers `loadEngine(materialId)`, sets `ready`
 *     when the engine is in memory, then kicks off a background flush
 *     to drain any queue left over from the previous session.
 *   - On every grade/graduation: caller awaits the action method, which
 *     applies locally and schedules a debounced flush.
 *   - On `visibilitychange` (tab hide) and `beforeunload`: synchronous
 *     flush attempt so we don't leak queued events across navigations.
 *
 * Stale-merge prompt: when `flush` returns a `needsConfirm` envelope,
 * the composable stores it on `staleSummary`. The view shows the modal
 * and calls `confirmMerge()` or `discardStale()` based on the user's
 * choice. (Modal UI lands with the MaterialView attribution work; the
 * composable surface is in place now so the wiring is clean.)
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
  /** Set by `flush` when the server returns `needsConfirm`. The view
   *  reads this to show the stale-merge confirmation modal. */
  const staleSummary = shallowRef<StaleSummary | null>(null)

  let materialId: string | null = null
  let debounceHandle: ReturnType<typeof setTimeout> | null = null

  function requireMaterial(name: string): string {
    if (!materialId) throw new Error(`useEngine.${name}: call init(materialId) first`)
    return materialId
  }

  async function refreshCounts() {
    if (!materialId) return
    pendingCount.value = await engineStore.pendingCount(materialId)
    orphanCount.value = (await idb.getOrphans(materialId)).length
  }

  function nowSecs(): number {
    return Math.floor(Date.now() / 1000)
  }

  async function doFlush(): Promise<FlushResult> {
    if (!materialId) return { accepted: 0, duplicates: 0, rebuilt: false }
    syncing.value = true
    try {
      const result = await engineStore.flush(materialId, nowSecs())
      if (result.needsConfirm) {
        staleSummary.value = result.needsConfirm
      } else {
        staleSummary.value = null
      }
      return result
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
      void doFlush().catch(() => {
        // Errors are surfaced via `error`; swallow to keep the debounce loop alive.
      })
    }, FLUSH_DEBOUNCE_MS)
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      void doFlush().catch(() => {})
    }
  }
  function onBeforeUnload() {
    void doFlush().catch(() => {})
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

  /** Boot the engine for the given material. Idempotent: re-calling
   *  with the same id is a no-op once `ready` is true. Switching to a
   *  different materialId mid-life isn't supported — useEngine binds
   *  the listeners and flush coalescing to one material per
   *  composable instance. */
  async function init(id: string) {
    if (ready.value && materialId === id) return
    if (materialId && materialId !== id) {
      throw new Error(
        `useEngine.init: materialId already bound to ${materialId}, refusing switch to ${id}`,
      )
    }
    materialId = id
    try {
      await engineStore.loadEngine(materialId, nowSecs())
      await refreshCounts()
      ready.value = true
      // Drain any queue left over from a prior session before the user
      // does anything new. Backgrounded — don't block the UI on it.
      void doFlush().catch(() => {})
    } catch (e) {
      error.value = e
    }
  }

  // --- Public surface ---

  async function submitGrade(cardId: number, grade: Grade) {
    const id = requireMaterial('submitGrade')
    const updates = await engineStore.submitGrade(id, cardId, grade, nowSecs())
    await refreshCounts()
    scheduleFlush()
    return updates
  }

  async function submitGraduation(verseId: number) {
    const id = requireMaterial('submitGraduation')
    const count = await engineStore.submitGraduation(id, verseId, nowSecs())
    await refreshCounts()
    scheduleFlush()
    return count
  }

  function nextReviewCard(): number | null {
    return engineStore.nextReviewCard(requireMaterial('nextReviewCard'), nowSecs())
  }

  function memorizeSession(limit: number): unknown {
    return engineStore.memorizeSession(requireMaterial('memorizeSession'), limit)
  }

  function newCardCount(): number {
    return engineStore.newCardCount(requireMaterial('newCardCount'))
  }

  function cardCountByClub(): unknown {
    return engineStore.cardCountByClub(requireMaterial('cardCountByClub'))
  }

  async function getCardRender(cardId: number): Promise<CardRender> {
    return engineStore.getCardRender(requireMaterial('getCardRender'), cardId, nowSecs())
  }

  /** Re-POST the queue with `confirmMerge: true` after the user
   *  approves the stale-merge modal. Implementation lands with the
   *  modal UI; for now the queue stays put. */
  async function confirmMerge() {
    // TODO: re-flush with confirmMerge:true once the modal ships.
    staleSummary.value = null
    return doFlush()
  }

  /** Drop the queued events the server flagged stale. The user
   *  explicitly chose to throw them away. */
  async function discardStale() {
    const id = requireMaterial('discardStale')
    const queued = await idb.getQueuedEvents(id)
    await idb.deleteQueuedEvents(queued.map((q) => q.clientEventId))
    staleSummary.value = null
    await refreshCounts()
    // Pull fresh state so the local engine matches the server's pre-discard view.
    await engineStore.loadEngine(id, nowSecs())
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
    flush: doFlush,
    confirmMerge,
    discardStale,
  }
}

export type EngineComposable = ReturnType<typeof useEngine>
