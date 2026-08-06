/**
 * Schedule data model + pure manipulation helpers for the schedule
 * editor at /schedule/<materialId>. Mirrors the canonical v2 shape from
 * `SchedulePayloadV2` in `packages/api/src/lib/schedules.ts`: each
 * `Week` carries `blocks: PassageBlock[]` (empty on review, length 1
 * on today's normal weeks, length ≥2 for future NT-Survey compound
 * weeks). The wire form the API stores may still be v1 (single-passage)
 * for pre-migration user rows and for the bundled schedule JSONs;
 * `migrateSchedule` normalises both into v2 at read time.
 *
 * Everything here is data-only — no Vue, no network — so the view can
 * hold a draft, mutate it through these helpers, then PUT it verbatim.
 *
 * Day-of-week shift semantics: per the Phase 3 design, the user picks
 * the weekly practice day and all weeks move by the signed delta from
 * the old day to the new day. There are no per-week date overrides —
 * `meetingDayOfWeek` plus the relative spacing between weeks fully
 * determines week dates. Meets keep their own dates (often weekend
 * dates that don't align with the practice day) and are unaffected by
 * the shift.
 */

export const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]

const DAY_NAMES_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/** Full day name (e.g. `Wednesday`) for a 3-letter `DayOfWeek` (e.g.
 *  `Wed`). The `${abbrev}days` shorthand silently produces "Tuedays" /
 *  "Weddays" / "Thudays" / "Satdays" — use this when rendering to the
 *  user. */
export function fullDayName(day: DayOfWeek): string {
  return DAY_NAMES_LONG[DAYS_OF_WEEK.indexOf(day)]!
}

export interface SchedulePassage {
  book: string
  chapter: number
  startVerse: number
  endVerse: number
}

export interface ScheduleVerses {
  club150?: number[]
  club300?: number[]
}

/** One passage's worth of a week's content. Normal weeks carry a single
 *  block; compound weeks (e.g. NT Survey's `|` weeks) carry two. */
export interface PassageBlock {
  passage: SchedulePassage
  verses: ScheduleVerses
}

export interface ScheduleWeek {
  /** ISO `YYYY-MM-DD`. Falls on `meetingDayOfWeek` by construction;
   *  changing the schedule's meeting day shifts all week dates by
   *  the signed delta.
   *
   *  TODO(schedule-shape-bump): this is a stored invariant —
   *  `applyMeetingDayShift` has to rewrite every week's `date` each
   *  time the meeting day changes, and the on-disk JSONs carry
   *  redundant information (every week's date is derivable from
   *  schedule.weeks[0].date + index * 7). The cleaner shape is a
   *  single `startDate` on `Schedule` with per-week dates derived.
   *  Deferred — touches the on-disk schedules, the API validator's
   *  per-week loop, and the WASM `parse_schedule` deserialiser. */
  date: string
  /** Passage blocks for this week. Empty on review weeks; length 1 on
   *  today's normal weeks; length ≥2 for future compound weeks.
   *
   *  Multi-block support (length ≥2) is accepted end-to-end here on
   *  the client, but the API rejects it at the WASM boundary until
   *  the Rust contract crate learns to consume it — see the redesign
   *  spec's phase 6 for the follow-up work. */
  blocks: PassageBlock[]
  isReview: boolean
}

export interface ScheduleMeet {
  id: string
  name: string
  startDate: string
  endDate: string
  location: string
}

export interface Schedule {
  version: 2
  materialId: string
  season: string
  title: string
  meetingDayOfWeek: DayOfWeek
  weeks: ScheduleWeek[]
  meets: ScheduleMeet[]
}

// =============================================================================
// Date helpers
// =============================================================================

/** Parse `YYYY-MM-DD` into a UTC-anchored Date so the arithmetic
 *  stays timezone-free. */
function parseIsoDate(s: string): Date {
  return new Date(`${s}T00:00:00Z`)
}

/** Format a UTC Date back to `YYYY-MM-DD`. */
function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function dayOfWeekIndex(day: DayOfWeek): number {
  return DAYS_OF_WEEK.indexOf(day)
}

/** Shift an ISO date string by `deltaDays` (signed). */
export function shiftDate(iso: string, deltaDays: number): string {
  const d = parseIsoDate(iso)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return formatIsoDate(d)
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/** Full month name (e.g. `September`) for a `YYYY-MM-DD` date. */
export function monthName(iso: string): string {
  return MONTH_NAMES[parseIsoDate(iso).getUTCMonth()]!
}

/** Day of month from `YYYY-MM-DD`. */
export function dayOfMonth(iso: string): number {
  return parseIsoDate(iso).getUTCDate()
}

/** English ordinal suffix: 1st, 2nd, 3rd, 4th, …, 21st, 22nd, 23rd, 24th…
 *  Used for the table-date column ("- 11th") in the schedule view,
 *  which lays out the season under month headers and so leaves only
 *  the ordinal day-of-month to scan against the printable schedule. */
export function englishOrdinal(day: number): string {
  const mod100 = day % 100
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`
  const mod10 = day % 10
  if (mod10 === 1) return `${day}st`
  if (mod10 === 2) return `${day}nd`
  if (mod10 === 3) return `${day}rd`
  return `${day}th`
}

/** Sunday-anchored week-key for an ISO date — the Sunday of the
 *  Sun-Sat week containing the date. Two dates share a week iff they
 *  produce the same key. Sunday-first to match the project-wide
 *  convention (see `applyMeetingDayShift`'s docstring). */
export function isoWeekStart(iso: string): string {
  const d = parseIsoDate(iso)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return formatIsoDate(d)
}

// =============================================================================
// Schedule helpers (pure)
// =============================================================================

/** Normalise a schedule payload of either accepted wire version (1 or 2)
 *  to the v2 in-memory shape. Mirrors
 *  `packages/api/src/lib/schedules.ts:migrateSchedule` so persisted user
 *  schedules and bundled JSONs land in the same shape whether they were
 *  saved before or after the redesign's phase 2. */
export function migrateSchedule(raw: unknown): Schedule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('schedule must be an object')
  }
  const obj = raw as Record<string, unknown>
  const version = obj.version
  if (version !== 1 && version !== 2) {
    throw new Error(`unsupported schedule version: ${String(version)}`)
  }
  const weeksRaw = obj.weeks
  if (!Array.isArray(weeksRaw)) throw new Error('missing weeks array')
  const weeks: ScheduleWeek[] = weeksRaw.map((w) => {
    const wo = w as Record<string, unknown>
    const isReview = wo.isReview === true
    const date = wo.date as string
    // Precedence matches the API's `migrateV1Week`, core's
    // `ScheduleWeekRaw`, and migration 0025: existing blocks win, then a
    // week-level passage folds into one block regardless of `isReview`,
    // then nothing. This is the copy that reads rows written before #103
    // canonicalised them.
    const blocks = (wo.blocks as PassageBlock[] | undefined) ?? []
    if (version === 2 || blocks.length > 0) {
      return { date, isReview, blocks }
    }
    const passage = wo.passage as SchedulePassage | null | undefined
    const verses = (wo.verses as ScheduleVerses | null | undefined) ?? {}
    return { date, isReview, blocks: passage ? [{ passage, verses }] : [] }
  })
  return {
    version: 2,
    materialId: obj.materialId as string,
    season: obj.season as string,
    title: obj.title as string,
    meetingDayOfWeek: obj.meetingDayOfWeek as DayOfWeek,
    weeks,
    meets: (obj.meets as ScheduleMeet[] | undefined) ?? [],
  }
}

/** Deep-clone a schedule. Uses JSON round-trip rather than
 *  `structuredClone` because the call sites in `ScheduleEditorView`
 *  pass `saved.value` / `draft.value` — Vue wraps ref-held objects
 *  in a reactive Proxy, and `structuredClone` throws
 *  `Proxy object could not be cloned` on those. `JSON.stringify`
 *  walks the proxy's [[Get]] trap correctly and emits the plain
 *  underlying data; nested `blocks[]` arrays round-trip fine. */
export function cloneSchedule(s: Schedule): Schedule {
  return JSON.parse(JSON.stringify(s)) as Schedule
}

/** Shift every week's date to land on `newDay` within the same
 *  calendar week (Sun-Sat). Returns a new schedule; doesn't mutate
 *  the input. Meets are left alone — they have their own dates
 *  independent of the practice day.
 *
 *  The week is the contiguous Sun-Sat block containing the current
 *  date. The new date is `weekStartSunday + newDayIndex`, which is
 *  equivalent to `oldDate + (newDayIndex - oldDayIndex)` when every
 *  week already falls on `meetingDayOfWeek` (the schedule's
 *  invariant). So Mon→Fri is +4 (Friday of the same week), Sat→Sun
 *  is -6 (Sunday that starts the same week containing that
 *  Saturday), Sun→Sat is +6. Never wraps to an adjacent calendar
 *  week. */
export function applyMeetingDayShift(s: Schedule, newDay: DayOfWeek): Schedule {
  const deltaDays = dayOfWeekIndex(newDay) - dayOfWeekIndex(s.meetingDayOfWeek)
  if (deltaDays === 0) return cloneSchedule(s)
  const next = cloneSchedule(s)
  next.meetingDayOfWeek = newDay
  for (const w of next.weeks) {
    w.date = shiftDate(w.date, deltaDays)
  }
  return next
}

/** Insert a new week at `index`. The caller picks the date + passage;
 *  this helper just slots the row in. The incoming `week` is trusted
 *  to be caller-owned (every call site builds it as a fresh literal),
 *  so we skip the per-argument clone — `cloneSchedule` above already
 *  produced an owned copy of the destination. */
export function addWeekAt(s: Schedule, index: number, week: ScheduleWeek): Schedule {
  const next = cloneSchedule(s)
  const clamped = Math.max(0, Math.min(next.weeks.length, index))
  next.weeks.splice(clamped, 0, week)
  return next
}

export function removeWeekAt(s: Schedule, index: number): Schedule {
  if (index < 0 || index >= s.weeks.length) return cloneSchedule(s)
  const next = cloneSchedule(s)
  next.weeks.splice(index, 1)
  return next
}

/** Build a stable, URL-safe meet id from a name. Used when the user
 *  creates a meet — the chain UI's "after major checkpoint" gate
 *  references meets by id, so we want deterministic ids that survive
 *  small typos in the name. */
export function slugifyMeetId(name: string, existing: readonly string[]): string {
  const stem
    = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'meet'
  let candidate = stem
  let suffix = 2
  const seen = new Set(existing)
  while (seen.has(candidate)) {
    candidate = `${stem}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function addMeet(s: Schedule, meet: ScheduleMeet): Schedule {
  const next = cloneSchedule(s)
  next.meets.push(meet)
  return next
}

export function updateMeet(s: Schedule, id: string, patch: ScheduleMeet): Schedule {
  const next = cloneSchedule(s)
  const i = next.meets.findIndex((m) => m.id === id)
  if (i < 0) return next
  next.meets[i] = patch
  return next
}

export function removeMeet(s: Schedule, id: string): Schedule {
  const next = cloneSchedule(s)
  next.meets = next.meets.filter((m) => m.id !== id)
  return next
}

// =============================================================================
// Display helpers
// =============================================================================

/** True when a block carries a real passage — book set, chapter and
 *  verses ≥ 1, `endVerse` ≥ `startVerse`.
 *
 *  A block is half-filled for as long as the user is mid-cascade in the
 *  editor's picker: choosing a book resets chapter and both verse fields
 *  to 0 on purpose, so "empty" is a transient edit state rather than a
 *  data defect. That's why the read side skips such blocks instead of
 *  refusing to store them. */
export function isNonEmptyBlock(block: PassageBlock): boolean {
  const { book, chapter, startVerse, endVerse } = block.passage
  return book !== '' && chapter >= 1 && startVerse >= 1 && endVerse >= startVerse
}

/** The blocks a week actually shows. Every read-side consumer — the
 *  rendered ledger, the row-height math, the save-time strip — wants
 *  this rather than `week.blocks`, and they have to agree: counting a
 *  half-filled block the template then declines to render leaves a gap
 *  in the grid. */
export function contentBlocks(week: ScheduleWeek): PassageBlock[] {
  return week.blocks.filter(isNonEmptyBlock)
}

/** Pretty passage label, e.g. "1 Corinthians 5:1-13". Returns "Review"
 *  for review weeks (passage === null). */
export function formatPassage(passage: SchedulePassage | null): string {
  if (passage === null) return 'Review'
  const { book, chapter, startVerse, endVerse } = passage
  if (startVerse === endVerse) return `${book} ${chapter}:${startVerse}`
  return `${book} ${chapter}:${startVerse}-${endVerse}`
}

/** ISO weekday index (0 = Sun) for a `YYYY-MM-DD` date, using
 *  UTC-anchored parsing so Fri stays Fri regardless of the user's
 *  local timezone. Shared with the season-range editor's meeting-day
 *  guard. */
export function isoWeekday(iso: string): number {
  return parseIsoDate(iso).getUTCDay()
}

// =============================================================================
// Verse-list parsing (comma-text editor input → number[])
// =============================================================================

/** Parse a comma- or space-separated verse list string into a sorted
 *  array of positive integers. Used by the per-week editor when the user
 *  blurs a text input. All-or-nothing: returns null if *any* token isn't
 *  a positive integer, so the caller can keep the old value rather than
 *  silently accepting a partial list the user didn't mean. Whitespace
 *  alone is an empty list, not an error. */
export function parseVerseList(input: string): number[] | null {
  const tokens = input.split(/[\s,]+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return []
  const out: number[] = []
  for (const t of tokens) {
    const n = Number(t)
    if (!Number.isInteger(n) || n <= 0) return null
    out.push(n)
  }
  return out.sort((a, b) => a - b)
}

/** Format a verse list back to the text the editor displays. */
export function formatVerseList(verses: readonly number[] | undefined): string {
  return verses ? verses.join(', ') : ''
}

// =============================================================================
// Coverage validation — does the schedule cover every verse in the material,
// exactly once?
// =============================================================================

/** A contiguous verse range within a single chapter. */
export interface CoverageRange {
  book: string
  chapter: number
  startVerse: number
  endVerse: number
}

/** A stretch of material verses no week's block covers — the user's
 *  season leaves these verses unscheduled. */
export interface CoverageGap extends CoverageRange {}

/** A stretch of material verses covered by more than one block. Each
 *  covering week's index is listed so the UI can jump to them. */
export interface CoverageOverlap extends CoverageRange {
  weekIdxs: number[]
}

export interface CoverageResult {
  gaps: CoverageGap[]
  overlaps: CoverageOverlap[]
  /** True when the material's expected verse set is empty (the
   *  `/passages` endpoint returned no verses — e.g. dev environment
   *  without the content pipeline). Consumers should suppress the
   *  gap/overlap UI in that case since neither list means anything. */
  materialEmpty: boolean
}

/** One entry per material verse — book/chapter/verse plus the deck's
 *  club tags. Mirrors the `/api/materials/:id/passages` response. */
export interface MaterialVerseEntry {
  book: string
  chapter: number
  verse: number
  clubs: number[]
}

/** Compute per-verse coverage of the material by the schedule's week
 *  blocks: gaps (verses in the material with no block covering them)
 *  and overlaps (verses covered by two or more blocks). Both lists are
 *  collapsed into contiguous ranges keyed by `(book, chapter)` for a
 *  compact display; an overlap range is only merged when every verse in
 *  it shares the same covering-week set.
 *
 *  The material entry set defines what "must be covered" — verses a
 *  block references that don't appear in the material (a typo in
 *  chapter or verse) do NOT surface here. Callers can catch those via
 *  the API's shape validator on save. */
export function computeCoverage(
  schedule: Schedule,
  material: readonly MaterialVerseEntry[],
): CoverageResult {
  if (material.length === 0) {
    return { gaps: [], overlaps: [], materialEmpty: true }
  }
  const expected = new Set<string>()
  const byKey = new Map<string, { book: string; chapter: number; verse: number }>()
  for (const v of material) {
    const key = `${v.book}|${v.chapter}|${v.verse}`
    expected.add(key)
    byKey.set(key, { book: v.book, chapter: v.chapter, verse: v.verse })
  }
  // For each material verse, which week indices cover it. Zero coverers
  // → gap; two or more → overlap.
  const coverers = new Map<string, number[]>()
  schedule.weeks.forEach((w, weekIdx) => {
    for (const block of w.blocks) {
      const { book, chapter, startVerse, endVerse } = block.passage
      if (!book || chapter < 1 || startVerse < 1 || endVerse < startVerse) continue
      for (let v = startVerse; v <= endVerse; v++) {
        const key = `${book}|${chapter}|${v}`
        // Only track coverers for verses the material knows about —
        // out-of-material verses aren't a coverage problem.
        if (!expected.has(key)) continue
        const list = coverers.get(key)
        if (list === undefined) coverers.set(key, [weekIdx])
        else if (!list.includes(weekIdx)) list.push(weekIdx)
      }
    }
  })
  const gapVerses: { book: string; chapter: number; verse: number }[] = []
  const overlapVerses: {
    book: string
    chapter: number
    verse: number
    weekIdxs: number[]
  }[] = []
  for (const key of expected) {
    const list = coverers.get(key)
    const meta = byKey.get(key)!
    if (list === undefined || list.length === 0) {
      gapVerses.push(meta)
    } else if (list.length > 1) {
      overlapVerses.push({ ...meta, weekIdxs: [...list].sort((a, b) => a - b) })
    }
  }
  // Sort by (book, chapter, verse) for stable ordering AND range
  // collapse. Books stay in the order the material listed them — but
  // since the material set is a Map iterated by insertion, sorting here
  // by (book, chapter, verse) is enough for compact output.
  const byBookChapterVerse = (
    a: { book: string; chapter: number; verse: number },
    b: { book: string; chapter: number; verse: number },
  ) => {
    if (a.book !== b.book) return a.book.localeCompare(b.book)
    if (a.chapter !== b.chapter) return a.chapter - b.chapter
    return a.verse - b.verse
  }
  gapVerses.sort(byBookChapterVerse)
  overlapVerses.sort(byBookChapterVerse)
  return {
    gaps: collapseGapRanges(gapVerses),
    overlaps: collapseOverlapRanges(overlapVerses),
    materialEmpty: false,
  }
}

function collapseGapRanges(
  verses: readonly { book: string; chapter: number; verse: number }[],
): CoverageGap[] {
  const out: CoverageGap[] = []
  for (const v of verses) {
    const last = out[out.length - 1]
    if (
      last
      && last.book === v.book
      && last.chapter === v.chapter
      && last.endVerse + 1 === v.verse
    ) {
      last.endVerse = v.verse
    } else {
      out.push({ book: v.book, chapter: v.chapter, startVerse: v.verse, endVerse: v.verse })
    }
  }
  return out
}

function collapseOverlapRanges(
  verses: readonly {
    book: string
    chapter: number
    verse: number
    weekIdxs: number[]
  }[],
): CoverageOverlap[] {
  const out: CoverageOverlap[] = []
  for (const v of verses) {
    const last = out[out.length - 1]
    if (
      last
      && last.book === v.book
      && last.chapter === v.chapter
      && last.endVerse + 1 === v.verse
      && sameNumberList(last.weekIdxs, v.weekIdxs)
    ) {
      last.endVerse = v.verse
    } else {
      out.push({
        book: v.book,
        chapter: v.chapter,
        startVerse: v.verse,
        endVerse: v.verse,
        weekIdxs: v.weekIdxs,
      })
    }
  }
  return out
}

function sameNumberList(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

