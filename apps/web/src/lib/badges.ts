/**
 * Memorize-tab badge math.
 *
 * Spec (docs/superpowers/specs/2026-06-14-schedules-and-settings-design.md
 * §"Memorize tab badge"):
 *
 *   badge = Σ over enabled clubs of  max(0, cumulative_through_current_week − memorized)
 *
 * v1 approximation: the API doesn't surface per-club graduated counts
 * yet, so we can't compute the exact spec formula. We use these signals:
 *
 *   - `cumulative_through_current_week` = sum of `verses.{enabled-club}.length`
 *     across schedule weeks up to and including the current week (the
 *     latest week whose `date <= today`). Derivable client-side from
 *     the schedule JSON.
 *
 *   - `newCardCount` = the engine's count of cards still in `New` state
 *     for this material, summed across all clubs. Used as a per-year
 *     ceiling: even if the schedule says many verses are due this week,
 *     the user can only memorize what's not already graduated.
 *
 * Per-year contribution = `min(newCardCount, cumulative)`:
 *
 *   - User caught up to plan (newCardCount < cumulative)  → newCardCount
 *     (the small leftover the user can still memorize)
 *   - User behind plan (newCardCount > cumulative)        → cumulative
 *     (this week's plan; doesn't blame them for lookahead)
 *
 * Years with no enabled memorize club contribute 0 — pressing Memorize
 * on that year wouldn't introduce any verse anyway.
 *
 * Years where `api.getSchedule()` returns null fall through to the
 * pre-Phase-2 behaviour (newCardCount verbatim) so the badge stays
 * useful for materials without a published schedule.
 */

import type { Club, YearView } from '@/api'
import { getCachedSchedule } from '@/lib/apiCache'
import { CLUBS, hasEnabledClub } from '@/lib/clubs'
import type { Schedule, ScheduleWeek } from '@/lib/schedule'

/** Return the index of the latest week whose date is on or before
 *  `today`, or -1 when today is before week 0. `weeks` is assumed
 *  sorted ascending by date (the server enforces this on PUT). Date
 *  comparison is purely string-lexicographic on ISO `YYYY-MM-DD`. */
function currentWeekIndex(weeks: readonly ScheduleWeek[], today: string): number {
  let idx = -1
  for (let i = 0; i < weeks.length; i++) {
    const week = weeks[i]
    if (!week) break
    if (week.date <= today) idx = i
    else break
  }
  return idx
}

/** Sum verse counts in schedule weeks [0, currentIdx] for each enabled
 *  club. Review weeks (verses === null) contribute zero. */
function cumulativeThroughWeek(
  weeks: readonly ScheduleWeek[],
  currentIdx: number,
  enabledClubs: readonly Club[],
): number {
  let sum = 0
  for (let i = 0; i <= currentIdx; i++) {
    const week = weeks[i]
    if (!week) continue
    for (const block of week.blocks) {
      for (const club of enabledClubs) {
        // Schedules only carry per-tier verse lists (club150 / club300).
        // A user enrolled in the 'full' tier memorises the whole passage
        // and doesn't have a per-week schedule contribution here.
        if (club === 'full') continue
        sum += block.verses[club]?.length ?? 0
      }
    }
  }
  return sum
}

/** Per-year badge contribution. Exported for unit testing; consumers
 *  use `memorizeBadgeCount` instead. */
export function badgeContribution(
  year: YearView,
  schedule: Schedule | null,
  today: string,
): number {
  const enabledClubs = CLUBS.filter((c) => year.perClub.memorize[c].enabled)
  if (enabledClubs.length === 0) return 0
  if (!schedule || schedule.weeks.length === 0) return year.newCardCount
  const idx = currentWeekIndex(schedule.weeks, today)
  // Today before week 0 of a published schedule (e.g. the user installs
  // the deck weeks before the season starts): the user can still
  // sequentially memorize verses, so fall back to newCardCount rather
  // than zeroing the badge. The schedule cap only kicks in once week 0
  // has arrived.
  if (idx < 0) return year.newCardCount
  const cumulative = cumulativeThroughWeek(schedule.weeks, idx, enabledClubs)
  return Math.min(year.newCardCount, cumulative)
}

/** Compute the schedule-aware Memorize badge count across every year.
 *  Skips years with no enabled memorize club before any network call —
 *  pressing Memorize on those years wouldn't introduce a verse anyway,
 *  and the badge fires on every navigation, so the saved round-trips
 *  add up for users with many catalog years.
 *
 *  Per-year fetch failures degrade gracefully: a single transient
 *  network error on one year falls back to `newCardCount` for that
 *  year rather than blanking the whole badge via Promise.all rejection. */
export async function memorizeBadgeCount(
  years: readonly YearView[],
  getSchedule: (materialId: string) => Promise<unknown | null>,
  todayIso: string,
): Promise<number> {
  const contributions = await Promise.all(
    years.map(async (year) => {
      if (!hasEnabledClub(year.perClub.memorize)) return 0
      let schedule: Schedule | null = null
      try {
        schedule = ((await getCachedSchedule(year.materialId, getSchedule)) as Schedule | null)
          ?? null
      } catch {
        // getCachedSchedule already evicted the rejected promise; fall
        // back to newCardCount for this year until the next nav retries.
      }
      return badgeContribution(year, schedule, todayIso)
    }),
  )
  return contributions.reduce((sum, c) => sum + c, 0)
}
