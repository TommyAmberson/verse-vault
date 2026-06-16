/**
 * Schedule data model + pure manipulation helpers for the schedule
 * editor at /schedule/<materialId>. Mirrors the on-disk JSON shape
 * (`data/schedules/<deck>-<season>.json`) and the server-side
 * `SchedulePayload` in `packages/api/src/lib/schedules.ts`. Everything
 * here is data-only — no Vue, no network — so the view can hold a
 * draft, mutate it through these helpers, then PUT it verbatim.
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

export interface ScheduleWeek {
  /** ISO `YYYY-MM-DD`. Falls on `meetingDayOfWeek` by construction;
   *  changing the schedule's meeting day shifts all week dates by
   *  the signed delta. */
  date: string
  /** Null on Review weeks. */
  passage: SchedulePassage | null
  /** Per-tier verse arrays for memorize Phase 1's "this week's primary"
   *  pull. Null on Review weeks. */
  verses: ScheduleVerses | null
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
  version: 1
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

const MS_PER_DAY = 86_400_000

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

// =============================================================================
// Schedule helpers (pure)
// =============================================================================

/** Deep-clone a schedule. Pure data shape so structuredClone is sound. */
export function cloneSchedule(s: Schedule): Schedule {
  return structuredClone(s)
}

/** Shift every week's date by the delta from the schedule's current
 *  meeting day to `newDay`, and update `meetingDayOfWeek` itself.
 *  Returns a new schedule; doesn't mutate the input. Meets are left
 *  alone — they have their own dates independent of the practice day. */
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
 *  this helper just slots the row in. */
export function addWeekAt(s: Schedule, index: number, week: ScheduleWeek): Schedule {
  const next = cloneSchedule(s)
  const clamped = Math.max(0, Math.min(next.weeks.length, index))
  next.weeks.splice(clamped, 0, structuredClone(week))
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
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  let candidate = base || 'meet'
  let suffix = 2
  const seen = new Set(existing)
  while (seen.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function addMeet(s: Schedule, meet: ScheduleMeet): Schedule {
  const next = cloneSchedule(s)
  next.meets.push(structuredClone(meet))
  return next
}

export function updateMeet(s: Schedule, id: string, patch: ScheduleMeet): Schedule {
  const next = cloneSchedule(s)
  const i = next.meets.findIndex((m) => m.id === id)
  if (i < 0) return next
  next.meets[i] = structuredClone(patch)
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

/** Pretty passage label, e.g. "1 Corinthians 5:1-13". Returns "Review"
 *  for review weeks (passage === null). */
export function formatPassage(passage: SchedulePassage | null): string {
  if (passage === null) return 'Review'
  const { book, chapter, startVerse, endVerse } = passage
  if (startVerse === endVerse) return `${book} ${chapter}:${startVerse}`
  return `${book} ${chapter}:${startVerse}-${endVerse}`
}

/** Count verses across enabled tiers for a single week. Used by the
 *  timeline pane to show a `5 / 5` summary per week. */
export function verseCountsForWeek(week: ScheduleWeek): { club150: number; club300: number } {
  return {
    club150: week.verses?.club150?.length ?? 0,
    club300: week.verses?.club300?.length ?? 0,
  }
}

// =============================================================================
// Verse-list parsing (comma-text editor input → number[])
// =============================================================================

/** Parse a comma- or space-separated verse list string into an array of
 *  positive integers, dropping invalid tokens. Used by the per-week
 *  editor when the user blurs a text input. Returns null when the input
 *  is non-empty but contains no valid tokens, so the caller can decide
 *  whether to keep the old value or accept the empty list. */
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
