import { describe, expect, it } from 'vitest'

// The fold fixtures come from `packages/api` on purpose. `migrateSchedule`
// below is a hand-written mirror of that package's `migrateV1Week` and of
// core's `ScheduleWeekRaw`; they are only correct insofar as they agree.
// Sharing the payloads across the package boundary is what turns a
// disagreement into a failing build instead of a review catch — this copy
// drifted from the other three twice during PR #131 (#132).
import {
  V1_REVIEW_WEEK_WITH_PASSAGE,
  V1_SCHEDULE,
  V1_WEEK_WITH_BOTH_SHAPES,
} from '../../../../packages/api/src/test-schedules'

import {
  type Schedule,
  applyMeetingDayShift,
  cloneSchedule,
  isoWeekday,
  migrateSchedule,
  parseVerseList,
  shiftDate,
  slugifyMeetId,
} from './schedule'

/** A canonical-shape schedule with the given week dates. Built as a typed
 *  literal rather than through `migrateSchedule` so tsc checks it and so
 *  the helper tests don't fail when the fold breaks. */
function schedule(dates: string[], meetingDayOfWeek: Schedule['meetingDayOfWeek'] = 'Mon'): Schedule {
  return {
    version: 2,
    materialId: 'nkjv-cor',
    season: '2025-26',
    title: 'T',
    meetingDayOfWeek,
    weeks: dates.map((date) => ({ date, isReview: false, blocks: [] })),
    meets: [],
  }
}

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
    // `isReview` does not gate the fold in core or in the API, so it must
    // not gate it here: the server engine would introduce these verses
    // while the editor showed the week as empty.
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

  it('defaults a missing meets array', () => {
    expect(migrateSchedule({ ...V1_SCHEDULE, meets: undefined }).meets).toEqual([])
  })

  it('rejects a payload that is not a versioned schedule', () => {
    expect(() => migrateSchedule(null)).toThrow(/must be an object/)
    expect(() => migrateSchedule({ ...V1_SCHEDULE, version: 3 })).toThrow(/unsupported/)
    expect(() => migrateSchedule({ ...V1_SCHEDULE, weeks: null })).toThrow(/weeks/)
  })
})

describe('shiftDate', () => {
  it('shifts across month, year, and leap-day boundaries', () => {
    expect(shiftDate('2025-09-29', 7)).toBe('2025-10-06')
    expect(shiftDate('2026-01-05', -7)).toBe('2025-12-29')
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29')
  })
})

describe('isoWeekday', () => {
  it('reads the weekday from the UTC-anchored parse', () => {
    // `parseIsoDate` appends `T00:00:00Z` precisely so the weekday can't
    // drift: west of UTC the naive `new Date(iso).getDay()` reports the
    // previous day. The suite runs under a non-UTC `TZ` (vitest.config.ts)
    // so a regression to local-time parsing fails here rather than only
    // in a user's browser.
    expect(isoWeekday('2025-09-08')).toBe(1)
    expect(isoWeekday('2025-09-14')).toBe(0)
  })
})

describe('applyMeetingDayShift', () => {
  it('moves every week by the signed day delta, in both directions', () => {
    const forward = applyMeetingDayShift(schedule(['2025-09-08', '2025-09-15']), 'Wed')
    expect(forward.meetingDayOfWeek).toBe('Wed')
    expect(forward.weeks.map((w) => w.date)).toEqual(['2025-09-10', '2025-09-17'])

    const back = applyMeetingDayShift(schedule(['2025-09-10'], 'Wed'), 'Mon')
    expect(back.weeks[0]!.date).toBe('2025-09-08')
  })

  it('spans the full week without wrapping', () => {
    // Sat→Sun is -6 and Sun→Sat is +6. A modulo-based delta would turn
    // these into +1 / -1 and silently move the season by a week.
    expect(applyMeetingDayShift(schedule(['2025-09-13'], 'Sat'), 'Sun').weeks[0]!.date)
      .toBe('2025-09-07')
    expect(applyMeetingDayShift(schedule(['2025-09-07'], 'Sun'), 'Sat').weeks[0]!.date)
      .toBe('2025-09-13')
  })

  it('leaves dates alone when the day is unchanged, and does not alias', () => {
    const before = schedule(['2025-09-08'])
    const out = applyMeetingDayShift(before, 'Mon')
    expect(out.weeks[0]!.date).toBe('2025-09-08')
    out.weeks[0]!.date = '1999-01-01'
    expect(before.weeks[0]!.date).toBe('2025-09-08')
  })
})

describe('cloneSchedule', () => {
  it('deep-copies weeks and meets', () => {
    // The editor mutates a draft in place and relies on the loaded
    // schedule not aliasing it.
    const before: Schedule = {
      ...schedule([]),
      weeks: [
        {
          date: '2025-09-08',
          isReview: false,
          blocks: [
            {
              passage: { book: 'John', chapter: 3, startVerse: 16, endVerse: 18 },
              verses: { club150: [16], club300: [] },
            },
          ],
        },
      ],
      meets: [
        { id: 'a', name: 'A', startDate: '2025-10-01', endDate: '2025-10-02', location: '' },
      ],
    }
    const copy = cloneSchedule(before)
    copy.weeks[0]!.blocks[0]!.verses.club150!.push(17)
    copy.meets[0]!.name = 'changed'
    expect(before.weeks[0]!.blocks[0]!.verses.club150).toEqual([16])
    expect(before.meets[0]!.name).toBe('A')
  })
})

describe('slugifyMeetId', () => {
  it('slugifies and de-duplicates against existing ids', () => {
    expect(slugifyMeetId('Fall Invitational', [])).toBe('fall-invitational')
    expect(slugifyMeetId('Fall Invitational', ['fall-invitational'])).toBe('fall-invitational-2')
    expect(slugifyMeetId('Fall Invitational', ['fall-invitational', 'fall-invitational-2']))
      .toBe('fall-invitational-3')
  })

  it('falls back to a usable stem when the name has no slug characters', () => {
    expect(slugifyMeetId('!!!', [])).toBe('meet')
    expect(slugifyMeetId('  ', ['meet'])).toBe('meet-2')
  })
})

describe('parseVerseList', () => {
  it('accepts comma- and space-separated lists and sorts them', () => {
    expect(parseVerseList('10, 2 5')).toEqual([2, 5, 10])
  })

  it('treats an empty input as an empty list, not an error', () => {
    expect(parseVerseList('   ')).toEqual([])
  })

  it('rejects the whole input when any token is not a positive integer', () => {
    expect(parseVerseList('1, 0')).toBeNull()
    expect(parseVerseList('1, 2.5')).toBeNull()
    // `Number('two')` is NaN, which `Number.isInteger` rejects — the
    // guard's name doesn't make that obvious.
    expect(parseVerseList('1, two')).toBeNull()
  })
})
