import { describe, expect, it } from 'vitest'

import { type HeatmapCell, academicYearStart, buildGrid, isoDate, monthRuns } from './heatmap'

/** UTC midnight for an ISO date, matching how the component builds its
 *  `today`-derived anchors. */
function day(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`)
}

function columns(cells: HeatmapCell[]): number {
  return (cells[cells.length - 1]?.col ?? -1) + 1
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function runNames(cells: HeatmapCell[]): string[] {
  return monthRuns(cells).map((r) => MONTH_NAMES[r.month] ?? '?')
}

const NO_COUNTS = new Map<string, number>()

describe('academicYearStart', () => {
  it('anchors on the September of the current season', () => {
    expect(isoDate(academicYearStart(day('2026-09-01')))).toBe('2026-09-01')
    expect(isoDate(academicYearStart(day('2027-06-15')))).toBe('2026-09-01')
    expect(isoDate(academicYearStart(day('2026-08-31')))).toBe('2025-09-01')
  })
})

describe('buildGrid', () => {
  const yearStart = day('2026-09-01')

  // #137: the grid used to stop at `today`, so eight days into a season it
  // was two columns wide and `width: 100%` scaled every SVG unit ~17×.
  it('spans the full academic year eight days in', () => {
    const young = buildGrid(yearStart, day('2026-09-08'), NO_COUNTS)
    const finished = buildGrid(yearStart, day('2027-09-01'), NO_COUNTS)

    expect(columns(young)).toBe(columns(finished))
    expect(columns(young)).toBeGreaterThanOrEqual(52)
  })

  it('leaves future days out of the window', () => {
    const cells = buildGrid(yearStart, day('2026-09-08'), NO_COUNTS)
    const inWindow = cells.filter((c) => c.inWindow)

    expect(inWindow[0]?.date).toBe('2026-09-01')
    expect(inWindow[inWindow.length - 1]?.date).toBe('2026-09-08')
    expect(cells.find((c) => c.date === '2026-09-09')?.inWindow).toBe(false)
  })

  it('starts on a Sunday and ends on a Saturday', () => {
    const cells = buildGrid(yearStart, day('2026-09-08'), NO_COUNTS)

    expect(cells[0]?.row).toBe(0)
    expect(cells[cells.length - 1]?.row).toBe(6)
    expect(cells.length % 7).toBe(0)
  })

  it('places counts on their own day and zeroes the rest', () => {
    const cells = buildGrid(yearStart, day('2026-09-08'), new Map([['2026-09-03', 12]]))

    expect(cells.find((c) => c.date === '2026-09-03')?.count).toBe(12)
    expect(cells.find((c) => c.date === '2026-09-04')?.count).toBe(0)
  })

  it('ignores counts dated outside the window', () => {
    const cells = buildGrid(yearStart, day('2026-09-08'), new Map([['2026-09-20', 9]]))

    expect(cells.find((c) => c.date === '2026-09-20')?.count).toBe(0)
  })

  it('marks the straddling end days as outside the academic year', () => {
    const cells = buildGrid(yearStart, day('2026-09-08'), NO_COUNTS)
    const inYear = cells.filter((c) => c.inYear)

    expect(inYear[0]?.date).toBe('2026-09-01')
    expect(inYear[inYear.length - 1]?.date).toBe('2027-08-31')
    // Future days are still in the year — that is what `inWindow` is for.
    expect(cells.find((c) => c.date === '2027-08-31')?.inWindow).toBe(false)
  })
})

describe('monthRuns', () => {
  const yearStart = day('2026-09-01')

  // The grid's last column runs Aug 29 – Sep 4, so counting all seven days
  // let the next academic year's September outvote August and emit a
  // thirteenth run at the far right.
  it('names twelve months once each, September through August', () => {
    expect(runNames(buildGrid(yearStart, day('2026-09-08'), NO_COUNTS))).toEqual([
      'Sep',
      'Oct',
      'Nov',
      'Dec',
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
    ])
  })

  it('labels the same twelve months once the year has elapsed', () => {
    expect(runNames(buildGrid(yearStart, day('2027-09-01'), NO_COUNTS))).toEqual(
      runNames(buildGrid(yearStart, day('2026-09-08'), NO_COUNTS)),
    )
  })

  // Aug 31 lands on a Saturday roughly one year in seven, which is the one
  // case where the grid needs no rounding past the year end.
  it('holds for a year ending exactly on a Saturday', () => {
    const runs = runNames(buildGrid(day('2029-09-01'), day('2030-09-01'), NO_COUNTS))

    expect(day('2030-08-31').getUTCDay()).toBe(6)
    expect(runs).toHaveLength(12)
    expect(runs[0]).toBe('Sep')
    expect(runs[11]).toBe('Aug')
  })

  it('covers every column with exactly one run', () => {
    const cells = buildGrid(yearStart, day('2026-09-08'), NO_COUNTS)
    const runs = monthRuns(cells)

    expect(runs[0]?.startCol).toBe(0)
    expect(runs[runs.length - 1]?.endCol).toBe(columns(cells) - 1)
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]?.startCol).toBe((runs[i - 1]?.endCol ?? -1) + 1)
    }
  })

  it('samples a date that belongs to the run’s own month', () => {
    for (const run of monthRuns(buildGrid(yearStart, day('2026-09-08'), NO_COUNTS))) {
      expect(day(run.sampleDate).getUTCMonth()).toBe(run.month)
    }
  })
})
