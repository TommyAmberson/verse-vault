/** Club-tier helpers shared across the badge math, engine boot, and the
 *  settings view — the enabled-club predicate had four hand-copied
 *  spellings before this module (#115). */

import type { Club, ClubStatus } from '@/api'

export const CLUBS: readonly Club[] = ['club150', 'club300', 'full'] as const

/** True when any tier in a per-club group (a `perClub.memorize` or
 *  `perClub.review` map) is enabled. Accepts either group shape — both
 *  carry an `enabled` boolean per tier. */
export function hasEnabledClub(group: Record<Club, { enabled: boolean }>): boolean {
  return Object.values(group).some((c) => c.enabled)
}

/** True when any tier has cards the review queue can serve.
 *
 *  Reads the per-tier status the years payload already carries rather
 *  than re-deriving it from the memorize/review pair: core owns that rule
 *  (`MaterialConfig::effective_status`) and the API mirrors it once
 *  (`effectiveStatus` in `routes/years.ts`). A third copy here is what
 *  produced the bug this predicate exists to fix — the client had its own
 *  stricter idea of which years /review could serve, and it drifted.
 *
 *  Paused is the only status with nothing behind it: `builder.rs` skips
 *  paused verses, so they emit no cards. Memorize-only reads as Active,
 *  and its verses come due like any other.
 *
 *  Year-level, so it asks whether any tier is unpaused while the builder
 *  asks per verse about that verse's most specific tier. The two agree
 *  for every shipped deck — no verse carries more than one club tag, and
 *  every deck has verses in all three tiers — and disagreeing only costs
 *  an engine boot that finds nothing due. */
export function hasReviewableClub(clubs: Record<string, { status: ClubStatus }>): boolean {
  return Object.values(clubs).some((c) => c.status !== 'paused')
}
