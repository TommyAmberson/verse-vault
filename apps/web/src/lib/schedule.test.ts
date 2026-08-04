import { describe, expect, it } from 'vitest'

// The fixtures come from `packages/api` on purpose. `migrateSchedule`
// below is a hand-written mirror of that package's `migrateV1Week` and
// of core's `ScheduleWeekRaw`; they are only correct insofar as they
// agree. Sharing the payloads across the package boundary is what turns
// a disagreement into a failing build instead of a review catch — this
// copy drifted from the other three twice during PR #131 (#132).
import {
  V1_REVIEW_WEEK_WITH_PASSAGE,
  V1_SCHEDULE,
  V1_WEEK_WITH_BOTH_SHAPES,
} from '../../../../packages/api/src/test-schedules.js'

import { migrateSchedule } from './schedule'

describe('migrateSchedule', () => {
  it('folds a v1 normal week into a single block', () => {
    const out = migrateSchedule(V1_SCHEDULE)
    expect(out.version).toBe(2)
    expect(out.weeks[0]!.isReview).toBe(false)
    expect(out.weeks[0]!.blocks).toHaveLength(1)
    expect(out.weeks[0]!.blocks[0]!.passage.book).toBe('1 Corinthians')
    expect(out.weeks[0]!.blocks[0]!.verses.club150).toEqual([5, 10])
  })

  it('folds a v1 review week carrying no passage to no blocks', () => {
    const out = migrateSchedule(V1_SCHEDULE)
    expect(out.weeks[1]!.isReview).toBe(true)
    expect(out.weeks[1]!.blocks).toEqual([])
  })

  it('keeps a passage a v1 review week does carry', () => {
    // `isReview` does not gate the fold in core or in the API, so it
    // must not gate it here: the server engine would introduce these
    // verses while the editor showed the week as empty.
    const out = migrateSchedule(V1_REVIEW_WEEK_WITH_PASSAGE)
    expect(out.weeks[0]!.isReview).toBe(true)
    expect(out.weeks[0]!.blocks).toHaveLength(1)
    expect(out.weeks[0]!.blocks[0]!.passage.endVerse).toBe(5)
  })

  it('prefers a v1 week existing blocks over its legacy pair', () => {
    // Same precedence as core's `ScheduleWeekRaw`, `migrateV1Week`, and
    // migration 0025. Picking the legacy pair here would show different
    // content than the engine is actually scheduling.
    const out = migrateSchedule(V1_WEEK_WITH_BOTH_SHAPES)
    expect(out.weeks[0]!.blocks).toHaveLength(1)
    expect(out.weeks[0]!.blocks[0]!.passage.chapter).toBe(2)
    expect(out.weeks[0]!.blocks[0]!.verses.club150).toEqual([3])
  })

  it('passes a v2 payload through unchanged', () => {
    const v2 = migrateSchedule(V1_SCHEDULE)
    expect(migrateSchedule(v2)).toEqual(v2)
  })

  it('backfills missing meets and weeks arrays', () => {
    const out = migrateSchedule({ ...V1_SCHEDULE, weeks: [], meets: undefined })
    expect(out.weeks).toEqual([])
    expect(out.meets).toEqual([])
  })

  it('rejects a payload that is not a versioned schedule', () => {
    expect(() => migrateSchedule(null)).toThrow(/must be an object/)
    expect(() => migrateSchedule({ ...V1_SCHEDULE, version: 3 })).toThrow(/unsupported/)
    expect(() => migrateSchedule({ ...V1_SCHEDULE, weeks: null })).toThrow(/weeks/)
  })
})
