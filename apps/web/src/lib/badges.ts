/**
 * Memorize-tab badge math.
 *
 * Spec (docs/superpowers/specs/2026-06-14-schedules-and-settings-design.md
 * §"Memorize tab badge"):
 *
 *   badge = Σ over enabled clubs of  max(0, cumulative_through_current_week − memorized)
 *
 * The server computes exactly that per year — `YearView.memorizeDebt`,
 * backed by `core::schedule::memorize_debt` — so the badge is a plain
 * sum. It used to be approximated here as `min(newCardCount, cumulative)`
 * over a client-side walk of the schedule JSON, which cost a schedule
 * fetch per year, mixed card counts with verse counts, and skipped the
 * Full tier because the client can't derive its per-week verses.
 *
 * Years with no enabled memorize club, and years the user isn't
 * enrolled in, report a zero backlog server-side and drop out on their
 * own. Years with no published schedule report their whole un-memorized
 * pool, which is what the badge showed before schedules existed.
 */

import type { YearView } from '@/api'

/** Schedule-aware Memorize badge count: verses the schedule has already
 *  asked for and the user hasn't memorized yet, across every year. */
export function memorizeBadgeCount(years: readonly YearView[]): number {
  return years.reduce((sum, year) => sum + year.memorizeDebt.verses, 0)
}
