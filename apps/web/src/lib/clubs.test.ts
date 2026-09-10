import { describe, expect, it } from 'vitest'

import type { Club, ClubStatus, ClubTier } from '@/api'

import { hasEnabledClub, hasReviewableClub } from './clubs'

function group(club150: boolean, club300 = false, full = false): Record<Club, { enabled: boolean }> {
  return {
    club150: { enabled: club150 },
    club300: { enabled: club300 },
    full: { enabled: full },
  }
}

function statuses(
  s150: ClubStatus,
  s300: ClubStatus = 'paused',
  sFull: ClubStatus = 'paused',
): Record<ClubTier, { status: ClubStatus }> {
  return { '150': { status: s150 }, '300': { status: s300 }, full: { status: sFull } }
}

describe('hasEnabledClub', () => {
  it('is true when any tier is on', () => {
    expect(hasEnabledClub(group(false))).toBe(false)
    expect(hasEnabledClub(group(true))).toBe(true)
    expect(hasEnabledClub(group(false, false, true))).toBe(true)
  })
})

describe('hasReviewableClub', () => {
  // Active is (memorize ✓, review anything) — the case that regressed.
  // Gating /review on review.enabled alone left a memorize-only year's
  // cards counted on Home and unreachable in the queue.
  it('accepts an active tier', () => {
    expect(hasReviewableClub(statuses('active'))).toBe(true)
  })

  it('accepts a maintenance tier', () => {
    expect(hasReviewableClub(statuses('maintenance'))).toBe(true)
  })

  it('rejects a year with every tier paused', () => {
    expect(hasReviewableClub(statuses('paused'))).toBe(false)
  })

  it('accepts when only a later tier is unpaused', () => {
    expect(hasReviewableClub(statuses('paused', 'paused', 'maintenance'))).toBe(true)
  })
})
