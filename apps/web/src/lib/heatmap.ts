/** Academic-year grid geometry for `ActivityHeatmap.vue`. Lives outside
 *  the component so the column arithmetic — the part that regressed in
 *  #137 — is testable without a DOM. */

// Academic year runs Sep 1 → Aug 31; anchored on September to match the
// curriculum cadence.
export const ACADEMIC_YEAR_START_MONTH = 8 // September (0-indexed)

const MS_PER_DAY = 86_400_000

export function academicYearStart(date: Date): Date {
  const calYear = date.getUTCMonth() < ACADEMIC_YEAR_START_MONTH
    ? date.getUTCFullYear() - 1
    : date.getUTCFullYear()
  return new Date(Date.UTC(calYear, ACADEMIC_YEAR_START_MONTH, 1))
}

function academicYearEnd(start: Date): Date {
  // Inclusive Aug 31 of the calendar year after `start`.
  return new Date(Date.UTC(start.getUTCFullYear() + 1, ACADEMIC_YEAR_START_MONTH - 1, 31))
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setUTCDate(d.getUTCDate() + n)
  return out
}

export interface HeatmapCell {
  date: string
  count: number
  row: number
  col: number
  month: number
  /** Inside the academic year. The first and last columns straddle the
   *  year boundary, so they carry cells from the neighbouring years. */
  inYear: boolean
  /** Inside the academic year *and* not in the future — the days that
   *  can carry activity. Always a subset of `inYear`. */
  inWindow: boolean
}

/** One cell per day from the Sunday on or before Sep 1 to the Saturday on
 *  or after Aug 31, so the grid's weekday edges stay square. Cells outside
 *  [yearStart, min(yearEnd, today)] carry `inWindow: false` and render
 *  blank.
 *
 *  The grid spans the whole academic year even when most of it is still in
 *  the future: anchoring the right edge on `today` instead collapsed a
 *  young season to a couple of columns, which the SVG's `width: 100%`
 *  then stretched ~17× (#137). */
export function buildGrid(
  yearStart: Date,
  today: Date,
  counts: ReadonlyMap<string, number>,
): HeatmapCell[] {
  const yearEnd = academicYearEnd(yearStart)
  const startIso = isoDate(yearStart)
  const yearEndIso = isoDate(yearEnd)
  const todayIso = isoDate(today)
  const windowEndIso = todayIso < yearEndIso ? todayIso : yearEndIso

  const leftAnchor = addDays(yearStart, -yearStart.getUTCDay())
  const rightAnchor = addDays(yearEnd, 6 - yearEnd.getUTCDay())

  const cells: HeatmapCell[] = []
  const totalDays = Math.round((rightAnchor.getTime() - leftAnchor.getTime()) / MS_PER_DAY) + 1
  for (let i = 0; i < totalDays; i += 1) {
    const cellDate = addDays(leftAnchor, i)
    const iso = isoDate(cellDate)
    const inYear = iso >= startIso && iso <= yearEndIso
    const inWindow = inYear && iso <= windowEndIso
    cells.push({
      date: iso,
      count: inWindow ? (counts.get(iso) ?? 0) : 0,
      row: cellDate.getUTCDay(),
      col: Math.floor(i / 7),
      month: cellDate.getUTCMonth(),
      inYear,
      inWindow,
    })
  }
  return cells
}

export interface MonthRun {
  month: number
  startCol: number
  endCol: number
  /** A date the run's month owns, for formatting the label text. */
  sampleDate: string
}

/** Contiguous stretches of columns sharing a dominant month — one label
 *  per run.
 *
 *  A column's month is decided by the days it owns *inside* the academic
 *  year. Both end columns straddle the boundary: a Sep-anchored year opens
 *  with a few August days and closes with a few September ones. Counting
 *  those would label the first column "Aug" and, because months carry no
 *  year, append a thirteenth "Sep" run at the far right — one belonging to
 *  the next academic year entirely. */
export function monthRuns(cells: readonly HeatmapCell[]): MonthRun[] {
  // Per column, how many in-year days each month owns, plus one of those
  // days to name the month with.
  const columns = new Map<number, Map<number, { days: number; sample: string }>>()
  for (const cell of cells) {
    if (!cell.inYear) continue
    let months = columns.get(cell.col)
    if (!months) {
      months = new Map()
      columns.set(cell.col, months)
    }
    const seen = months.get(cell.month)
    if (seen) seen.days += 1
    else months.set(cell.month, { days: 1, sample: cell.date })
  }

  const runs: MonthRun[] = []
  for (const col of [...columns.keys()].sort((a, b) => a - b)) {
    let month = -1
    let days = 0
    let sample = ''
    for (const [candidate, owned] of columns.get(col) ?? []) {
      if (owned.days > days) {
        month = candidate
        days = owned.days
        sample = owned.sample
      }
    }
    if (month === -1) continue

    const open = runs[runs.length - 1]
    // A column with no in-year days is absent from `columns` and so breaks
    // the run, which is what keeps two same-month runs from merging across
    // a gap.
    if (open && open.month === month && open.endCol === col - 1) open.endCol = col
    else runs.push({ month, startCol: col, endCol: col, sampleDate: sample })
  }
  return runs
}
