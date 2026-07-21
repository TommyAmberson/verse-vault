/**
 * Client-side caches for the per-navigation API fetches that the sidebar
 * badge (`App.vue`) and the mounting view fire near-simultaneously. Two
 * policies, because the two payloads have different freshness needs:
 *
 *   - **Schedules** are static within a tab session (they only change via
 *     the schedule editor's PUT/DELETE). Cache the resolved value until
 *     explicitly invalidated — an edit or a profile switch.
 *
 *   - **Years** carry `newCardCount` / enrolment, which move as the user
 *     grades, graduates, and edits settings; the badge deliberately
 *     re-fetches them every navigation. So only *in-flight* calls are
 *     coalesced (the resolved value is dropped on settle) — enough to
 *     collapse the badge + view double-fetch on a single navigation into
 *     one round-trip, without ever serving a stale count.
 *
 * Both were previously inline in `badges.ts`; lifted here (#120) so the
 * engine-boot path consumes a cache module rather than the badge module,
 * and extended with the years coalescer (#121).
 */

import type { YearsResponse } from '@/api'

// --- Schedules: retained until invalidated ----------------------------

const scheduleCache = new Map<string, Promise<unknown | null>>()

/** Fetch a material's schedule through the cache: a hit returns the shared
 *  (possibly in-flight) promise; a miss fetches once and caches it. A
 *  rejected fetch evicts itself so a transient failure doesn't pin a
 *  rejected promise for the session — the rejection still propagates, so
 *  callers that want a soft fallback add their own `.catch`. */
export function getCachedSchedule(
  materialId: string,
  fetch: (id: string) => Promise<unknown | null>,
): Promise<unknown | null> {
  const cached = scheduleCache.get(materialId)
  if (cached !== undefined) return cached
  const pending = fetch(materialId).catch((err) => {
    scheduleCache.delete(materialId)
    throw err
  })
  scheduleCache.set(materialId, pending)
  return pending
}

/** Drop cached schedules — one material, or all when omitted. Called by
 *  the schedule editor after a write and on profile/auth transitions. */
export function invalidateScheduleCache(materialId?: string): void {
  if (materialId === undefined) scheduleCache.clear()
  else scheduleCache.delete(materialId)
}

// --- Years: in-flight coalescing only ---------------------------------

let yearsInflight: Promise<YearsResponse> | null = null

/** Coalesce concurrent `getYears` calls (the badge + the mounting view on
 *  one navigation) into a single round-trip. The entry is dropped once the
 *  fetch settles, so the next navigation fetches fresh — years data moves
 *  with activity and must never be served stale. */
export function getCachedYears(fetch: () => Promise<YearsResponse>): Promise<YearsResponse> {
  if (yearsInflight) return yearsInflight
  const pending = fetch().finally(() => {
    if (yearsInflight === pending) yearsInflight = null
  })
  yearsInflight = pending
  return pending
}

/** Drop any in-flight years fetch so a profile switch can't hand the new
 *  profile the previous one's coalesced result. */
export function invalidateYearsCache(): void {
  yearsInflight = null
}
