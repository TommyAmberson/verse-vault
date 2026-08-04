import { describe, expect, it } from 'vitest'

import {
  applyMeetingDayShift,
  cloneSchedule,
  isoWeekday,
  migrateSchedule,
  parseVerseList,
  shiftDate,
  slugifyMeetId,
} from './schedule'

/** A minimal v2 schedule; `migrateSchedule` gives it the canonical shape
 *  so these tests exercise the same objects the editor holds. */
function schedule(dates: string[], meetingDayOfWeek = 'Mon') {
  return migrateSchedule({
    version: 2,
    materialId: 'nkjv-cor',
    season: '2025-26',
    title: 'T',
    meetingDayOfWeek,
    weeks: dates.map((date) => ({ date, isReview: false, blocks: [] })),
    meets: [],
  })
}

describe('shiftDate', () => {
  it('crosses a month boundary', () => {
    expect(shiftDate('2025-09-29', 7)).toBe('2025-10-06')
  })

  it('crosses a year boundary backwards', () => {
    expect(shiftDate('2026-01-05', -7)).toBe('2025-12-29')
  })

  it('handles a leap day', () => {
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29')
  })
})

describe('isoWeekday', () => {
  it('reads the weekday without a timezone shifting it', () => {
    // Parsed as a local date rather than a UTC instant: west of UTC, the
    // naive `new Date(iso).getDay()` reports the previous day.
    expect(isoWeekday('2025-09-08')).toBe(1)
    expect(isoWeekday('2025-09-14')).toBe(0)
  })
})

describe('applyMeetingDayShift', () => {
  it('moves every week by the signed day delta', () => {
    const out = applyMeetingDayShift(schedule(['2025-09-08', '2025-09-15']), 'Wed')
    expect(out.meetingDayOfWeek).toBe('Wed')
    expect(out.weeks.map((w) => w.date)).toEqual(['2025-09-10', '2025-09-17'])
  })

  it('shifts backwards when the new day precedes the old one', () => {
    const out = applyMeetingDayShift(schedule(['2025-09-10'], 'Wed'), 'Mon')
    expect(out.weeks[0]!.date).toBe('2025-09-08')
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
    const before = migrateSchedule({
      version: 2,
      materialId: 'nkjv-cor',
      season: 's',
      title: 't',
      meetingDayOfWeek: 'Mon',
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
      meets: [{ id: 'a', name: 'A', startDate: '2025-10-01', endDate: '2025-10-02' }],
    })
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

  it('rejects anything that is not a positive integer', () => {
    expect(parseVerseList('1, 0')).toBeNull()
    expect(parseVerseList('1, -2')).toBeNull()
    expect(parseVerseList('1, 2.5')).toBeNull()
    expect(parseVerseList('1, two')).toBeNull()
  })
})
