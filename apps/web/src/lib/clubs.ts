/** Club-tier helpers shared across the badge math, engine boot, and the
 *  settings view — the enabled-club predicate had four hand-copied
 *  spellings before this module (#115). */

import type { Club } from '@/api'

export const CLUBS: readonly Club[] = ['club150', 'club300', 'full'] as const

/** True when any tier in a per-club group (a `perClub.memorize` or
 *  `perClub.review` map) is enabled. Accepts either group shape — both
 *  carry an `enabled` boolean per tier. */
export function hasEnabledClub(group: Record<Club, { enabled: boolean }>): boolean {
  return Object.values(group).some((c) => c.enabled)
}
