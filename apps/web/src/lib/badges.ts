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

const CLUBS: readonly Club[] = ['club150', 'club300', 'full'] as const

const CLUB_TO_TIER_KEY: Record<Club, 'club150' | 'club300' | 'full'> = {
  club150: 'club150',
  club300: 'club300',
  full: 'full',
}

interface ScheduleWeek {
  date: string
  verses: Partial<Record<Club, number[]>> | null
  isReview?: boolean
}

interface Schedule {
  weeks: ScheduleWeek[]
}

/** Return the index of the latest week whose date is on or before
 *  `today`, or -1 when today is before week 0. `weeks` is assumed
 *  sorted ascending by date (the server enforces this on PUT). Date
 *  comparison is purely string-lexicographic on ISO `YYYY-MM-DD`. */
function currentWeekIndex(weeks: readonly ScheduleWeek[], today: string): number {
  let idx = -1
  for (let i = 0; i < weeks.length; i++) {
    if (weeks[i].date <= today) idx = i
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
    const w = weeks[i]?.verses
    if (!w) continue
    for (const club of enabledClubs) {
      sum += w[CLUB_TO_TIER_KEY[club]]?.length ?? 0
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
  if (idx < 0) return 0
  const cumulative = cumulativeThroughWeek(schedule.weeks, idx, enabledClubs)
  return Math.min(year.newCardCount, cumulative)
}

/** Compute the schedule-aware Memorize badge count across every year.
 *  Driver fetches schedules in parallel — one round-trip per enrolled
 *  year on top of the existing `getYears()` call. */
export async function memorizeBadgeCount(
  years: readonly YearView[],
  getSchedule: (materialId: string) => Promise<unknown | null>,
  todayIso: string,
): Promise<number> {
  const contributions = await Promise.all(
    years.map(async (year) => {
      const raw = await getSchedule(year.materialId)
      const schedule = (raw as Schedule | null) ?? null
      return badgeContribution(year, schedule, todayIso)
    }),
  )
  return contributions.reduce((sum, c) => sum + c, 0)
}
