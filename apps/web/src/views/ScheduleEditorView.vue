<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'

import { api, type MaterialPassages } from '@/api'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { invalidateScheduleCache } from '@/lib/badges'
import {
  DAYS_OF_WEEK,
  type DayOfWeek,
  type PassageBlock,
  type Schedule,
  type ScheduleMeet,
  type ScheduleWeek,
  addMeet,
  applyMeetingDayShift,
  cloneSchedule,
  type CoverageResult,
  computeCoverage,
  englishOrdinal,
  formatCoverageRange,
  formatPassage,
  fullDayName,
  isoWeekStart,
  monthName,
  removeMeet,
  shiftDate,
  slugifyMeetId,
  updateMeet,
} from '@/lib/schedule'

type Mode = 'view' | 'edit'

const route = useRoute()
const router = useRouter()

const materialId = computed(() => String(route.params.materialId ?? ''))

const saved = ref<Schedule | null>(null)
const draft = ref<Schedule | null>(null)
const mode = ref<Mode>('view')
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

/** Per-verse club-tag projection of the material's bundled
 *  MaterialData. Fetched once per material load and used to derive the
 *  Club 150 / 300 pill sets on the fly from each block's passage range.
 *  A `passageClubs` Map keyed by `${book}|${chapter}|${verse}` gives
 *  O(1) lookup so growing / shrinking a passage doesn't have to walk
 *  the full projection per re-render. */
type MaterialPassageEntry = MaterialPassages['passages'][number]
const materialPassages = ref<MaterialPassageEntry[]>([])
const passageClubs = computed<Map<string, number[]>>(() => {
  const m = new Map<string, number[]>()
  for (const p of materialPassages.value) {
    m.set(`${p.book}|${p.chapter}|${p.verse}`, p.clubs)
  }
  return m
})

/** Deck's book list in canonical order (first-seen in the projection),
 *  used to populate the passage picker's Book dropdown. */
const materialBooks = computed<string[]>(() => {
  const seen: string[] = []
  for (const p of materialPassages.value) {
    if (!seen.includes(p.book)) seen.push(p.book)
  }
  return seen
})

/** book → sorted list of chapter numbers present in the projection. */
const materialChaptersByBook = computed<Map<string, number[]>>(() => {
  const m = new Map<string, Set<number>>()
  for (const p of materialPassages.value) {
    let s = m.get(p.book)
    if (s === undefined) {
      s = new Set()
      m.set(p.book, s)
    }
    s.add(p.chapter)
  }
  const out = new Map<string, number[]>()
  for (const [k, v] of m) out.set(k, [...v].sort((a, b) => a - b))
  return out
})

/** (book, chapter) → sorted list of verse numbers present in the
 *  projection. Used to bound the Start / End verse dropdowns to the
 *  actual verses the material carries — a passage that references a
 *  verse the material doesn't have would surface as a coverage gap on
 *  neighbours but not the invalid passage itself. */
const materialVersesByChapter = computed<Map<string, number[]>>(() => {
  const m = new Map<string, number[]>()
  for (const p of materialPassages.value) {
    const key = `${p.book}|${p.chapter}`
    const arr = m.get(key)
    if (arr === undefined) m.set(key, [p.verse])
    else arr.push(p.verse)
  }
  for (const v of m.values()) v.sort((a, b) => a - b)
  return m
})

function chaptersFor(book: string): number[] {
  return materialChaptersByBook.value.get(book) ?? []
}

function versesFor(book: string, chapter: number): number[] {
  return materialVersesByChapter.value.get(`${book}|${chapter}`) ?? []
}

/** Source of truth for both the read-only view and the edit panes.
 *  Reading from `draft` in view mode is fine too (it's a clone of
 *  saved with no edits), but binding to `saved` while not editing
 *  keeps the contract clear: never mutate `saved` outside of refresh. */
const display = computed<Schedule | null>(() =>
  mode.value === 'edit' ? draft.value : saved.value,
)

/** Timeline selection. Tracks the WEEK INDEX (into display.weeks) or
 *  the MEET ID — never both at once. Stays null on first render so the
 *  detail pane shows a "pick something" hint instead of a stale
 *  selection from the prior route visit. */
type Selection =
  | { kind: 'week'; weekIdx: number }
  | { kind: 'meet'; meetId: string }
  | null

const selection = ref<Selection>(null)

/** A row in the printable-style schedule table: month-section header,
 *  practice week, or a meet weekend (renders as a full-width band).
 *  Rows are produced in chronological order; on a tied date, weeks
 *  sort before meets (the practice happens before the weekend meet)
 *  and month headers slot in whenever the calendar month changes. */
type TableRow =
  | { kind: 'month'; key: string; label: string }
  | {
    kind: 'week'
    key: string
    weekIdx: number
    week: ScheduleWeek
    ordinal: string
    isCurrent: boolean
  }
  | { kind: 'meet'; key: string; meet: ScheduleMeet; dateRange: string }

/** Sun-anchored week key for "today" — keeps the current-week
 *  highlight stable across nav events without re-evaluating Date on
 *  every render. */
const todayWeekKey = isoWeekStart(new Date().toISOString().slice(0, 10))

const rows = computed<TableRow[]>(() => {
  const s = display.value
  if (s === null) return []
  type Chronological =
    | { kind: 'week'; date: string; weekIdx: number; week: ScheduleWeek }
    | { kind: 'meet'; date: string; meet: ScheduleMeet }
  const items: Chronological[] = []
  s.weeks.forEach((week, weekIdx) =>
    items.push({ kind: 'week', date: week.date, weekIdx, week }),
  )
  s.meets.forEach((meet) => items.push({ kind: 'meet', date: meet.startDate, meet }))
  items.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date)
    if (a.kind !== b.kind) return a.kind === 'week' ? -1 : 1
    return 0
  })
  const result: TableRow[] = []
  let lastMonth = ''
  for (const it of items) {
    const m = monthName(it.date)
    if (m !== lastMonth) {
      result.push({ kind: 'month', key: `month-${it.date}`, label: m })
      lastMonth = m
    }
    if (it.kind === 'week') {
      result.push({
        kind: 'week',
        key: `week-${it.weekIdx}`,
        weekIdx: it.weekIdx,
        week: it.week,
        ordinal: englishOrdinal(Number(it.date.slice(8, 10))),
        isCurrent: isoWeekStart(it.date) === todayWeekKey,
      })
    } else {
      result.push({
        kind: 'meet',
        key: `meet-${it.meet.id}`,
        meet: it.meet,
        dateRange: formatMeetDateRange(it.meet),
      })
    }
  }
  return result
})

/** Click-to-toggle: a second click on the already-open row collapses
 *  the inline form (matches Esc). Any click on a different row swaps
 *  selection to that row. */
function selectWeek(weekIdx: number) {
  if (selection.value?.kind === 'week' && selection.value.weekIdx === weekIdx) {
    selection.value = null
    return
  }
  selection.value = { kind: 'week', weekIdx }
}

function selectMeet(meetId: string) {
  if (selection.value?.kind === 'meet' && selection.value.meetId === meetId) {
    selection.value = null
    return
  }
  selection.value = { kind: 'meet', meetId }
}

function isWeekRowSelected(weekIdx: number): boolean {
  return selection.value?.kind === 'week' && selection.value.weekIdx === weekIdx
}

function isMeetRowSelected(meetId: string): boolean {
  return selection.value?.kind === 'meet' && selection.value.meetId === meetId
}

/** Long-form weekday + month-day label for the timeline. ISO `YYYY-MM-DD`
 *  parses to a Date at UTC midnight; reading the UTC weekday avoids the
 *  user's timezone shifting the label by a day. */
function formatTimelineDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function formatMeetDateRange(meet: ScheduleMeet): string {
  if (meet.startDate === meet.endDate) return formatTimelineDate(meet.startDate)
  return `${formatTimelineDate(meet.startDate)} – ${formatTimelineDate(meet.endDate)}`
}

/** Custom-properties style bag driving the .wk row's date-cell span in
 *  the Ledger and Condensed regimes:
 *
 *  - `--wk-blocks` = how many block-rows the date spans in Ledger
 *    (one per passage; 1 on review weeks so the span math stays sane).
 *  - `--wk-rows`   = total flow rows the date spans in Condensed —
 *    each block contributes 3 flow rows (passage / 150 / 300).
 *
 *  Cards regime ignores both — the date is a badge above the block(s)
 *  rather than a rail alongside them. */
function weekGridStyle(week: ScheduleWeek): Record<string, string> {
  const blocks = week.isReview ? 1 : Math.max(1, week.blocks.length)
  return {
    '--wk-blocks': String(blocks),
    '--wk-rows': String(blocks * 3),
  }
}

const selectedWeek = computed<ScheduleWeek | null>(() => {
  if (selection.value?.kind !== 'week') return null
  return display.value?.weeks[selection.value.weekIdx] ?? null
})

/** Live per-week coverage report against the material's canonical
 *  verse set. Reads from `draft` in edit mode and `saved` otherwise so
 *  the report matches whatever the display is showing. Legit
 *  out-of-order schedules (e.g. OT Survey's every-other-week Psalms
 *  chapter) don't trip the check — the algorithm only flags verses no
 *  block covers (gaps) or verses two or more blocks cover (overlap),
 *  never the order they're memorised in. */
const coverageResult = computed<CoverageResult>(() => {
  const s = display.value
  if (s === null) return { gaps: [], overlaps: [], materialEmpty: true }
  return computeCoverage(s, materialPassages.value)
})

/** Week indices flagged by the coverage checker — every week that
 *  contributes to at least one overlap range. Rendered as a red
 *  left-rule on the affected week rows so the user can see what to
 *  fix without hunting through the coverage banner list. */
const coverageIssueWeeks = computed<Set<number>>(() => {
  const s = new Set<number>()
  for (const o of coverageResult.value.overlaps) {
    for (const i of o.weekIdxs) s.add(i)
  }
  return s
})

const coverageTotalIssues = computed(
  () =>
    coverageResult.value.gaps.length + coverageResult.value.overlaps.length,
)

const coverageBadgeAria = computed(() => {
  if (coverageResult.value.materialEmpty) {
    return 'Coverage check unavailable — no material data loaded'
  }
  if (coverageTotalIssues.value === 0) return 'Schedule covers every material verse exactly once'
  const g = coverageResult.value.gaps.length
  const o = coverageResult.value.overlaps.length
  return `Coverage has ${g} gap range${g === 1 ? '' : 's'} and ${o} overlap range${o === 1 ? '' : 's'}`
})

const selectedMeet = computed<ScheduleMeet | null>(() => {
  if (selection.value?.kind !== 'meet') return null
  return display.value?.meets.find((m) => m.id === selection.value!.meetId) ?? null
})

// =============================================================================
// Per-week editor state
// =============================================================================

/** Derive the verse numbers in a block's passage range that carry a
 *  given club tag, straight from the material's per-verse club
 *  projection. This is the single source of truth in the client —
 *  the schedule doesn't need to (and no longer will, once phase B
 *  lands) carry its own copy. Falls back to `block.verses` when the
 *  material projection hasn't loaded yet (offline / dev without the
 *  content pipeline). */
function derivedVerseNumbers(
  block: PassageBlock,
  club: 150 | 300,
): number[] {
  const { book, chapter, startVerse, endVerse } = block.passage
  if (!book || chapter < 1 || startVerse < 1 || endVerse < startVerse) return []
  const clubs = passageClubs.value
  if (clubs.size === 0) {
    // Projection not loaded — fall back to whatever the schedule
    // stored so the display isn't blank on a slow / offline first
    // paint.
    const stored = club === 150 ? block.verses.club150 : block.verses.club300
    return Array.from(new Set(stored ?? [])).sort((a, b) => a - b)
  }
  const out: number[] = []
  for (let v = startVerse; v <= endVerse; v++) {
    const c = clubs.get(`${book}|${chapter}|${v}`)
    if (c && c.includes(club)) out.push(v)
  }
  return out
}

/** Cumulative memorize-scope count for a block: 150 = |club150|,
 *  300 = |club150 ∪ club300|, Full = passage size. Reflects the
 *  Bible-quiz convention that the tiers stack — a 300 kid memorizes
 *  both 150 and 300 verses; a Full kid memorizes the whole passage. */
function cumulativeCount(block: PassageBlock, tier: 'club150' | 'club300' | 'full'): number {
  if (tier === 'club150') return derivedVerseNumbers(block, 150).length
  if (tier === 'club300') {
    const union = new Set<number>([
      ...derivedVerseNumbers(block, 150),
      ...derivedVerseNumbers(block, 300),
    ])
    return union.size
  }
  const { startVerse, endVerse } = block.passage
  if (startVerse < 1 || endVerse < startVerse) return 0
  return endVerse - startVerse + 1
}

function updateBlockPassageField<K extends 'book' | 'chapter' | 'startVerse' | 'endVerse'>(
  blockIdx: number,
  key: K,
  value: K extends 'book' ? string : number,
) {
  updateBlockPassage(blockIdx, { [key]: value } as Partial<PassageBlock['passage']>)
}

/** Apply a multi-field patch to a block's passage. Handles the cascade
 *  when a higher-level field changes (book → resets chapter + verses;
 *  chapter → resets verses; startVerse pushing past endVerse → clamps
 *  endVerse up), so the passage never lands in an internally invalid
 *  state. Re-derives club-tagged verse lists from the material after
 *  every change. */
function updateBlockPassage(
  blockIdx: number,
  patch: Partial<PassageBlock['passage']>,
) {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const idx = selection.value.weekIdx
  const week = draft.value.weeks[idx]
  if (!week) return
  const block = week.blocks[blockIdx]
  if (!block) return
  const nextBlocks = week.blocks.map((b, i) => {
    if (i !== blockIdx) return b
    let nextPassage = { ...b.passage, ...patch }
    if (patch.book !== undefined && patch.book !== b.passage.book) {
      nextPassage = { ...nextPassage, chapter: 0, startVerse: 0, endVerse: 0 }
    }
    if (patch.chapter !== undefined && patch.chapter !== b.passage.chapter) {
      // Auto-fill Start / End to the full chapter — the common case
      // is memorising a whole chapter, and requiring the user to
      // click Start and End every time turned 2 clicks into 4. Override
      // is one click away when the passage really is a subset.
      const verses = versesFor(nextPassage.book, nextPassage.chapter)
      if (verses.length > 0) {
        nextPassage = {
          ...nextPassage,
          startVerse: verses[0]!,
          endVerse: verses[verses.length - 1]!,
        }
      } else {
        nextPassage = { ...nextPassage, startVerse: 0, endVerse: 0 }
      }
    }
    if (
      patch.startVerse !== undefined
      && nextPassage.startVerse > 0
      && nextPassage.endVerse > 0
      && nextPassage.startVerse > nextPassage.endVerse
    ) {
      nextPassage = { ...nextPassage, endVerse: nextPassage.startVerse }
    }
    const nextVerses = deriveVersesForPassage(nextPassage, b.verses)
    return { ...b, passage: nextPassage, verses: nextVerses }
  })
  draft.value.weeks[idx] = { ...week, blocks: nextBlocks }
}

/** Recompute `{ club150, club300 }` for a block from the material's
 *  verse projection. Any verse in `[startVerse, endVerse]` whose
 *  material entry tags 150 lands in `club150`; same for 300. Verses
 *  tagged both (rare but valid on disk) land in both lists. */
function deriveVersesForPassage(
  passage: PassageBlock['passage'],
  fallback: PassageBlock['verses'],
): PassageBlock['verses'] {
  const { book, chapter, startVerse, endVerse } = passage
  if (!book || chapter < 1 || startVerse < 1 || endVerse < startVerse) {
    return { club150: [], club300: [] }
  }
  const clubs = passageClubs.value
  if (clubs.size === 0) {
    // Projection not loaded — keep whatever was stored so the row
    // round-trips through save without a data loss on a slow first
    // paint.
    return fallback
  }
  const c150: number[] = []
  const c300: number[] = []
  for (let v = startVerse; v <= endVerse; v++) {
    const tags = clubs.get(`${book}|${chapter}|${v}`)
    if (!tags) continue
    if (tags.includes(150)) c150.push(v)
    if (tags.includes(300)) c300.push(v)
  }
  return { club150: c150, club300: c300 }
}

function addPassageBlock() {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const idx = selection.value.weekIdx
  const week = draft.value.weeks[idx]
  if (!week) return
  const defaultPassage = nextPassageAfter(idx)
  const newBlock: PassageBlock = {
    passage: defaultPassage,
    verses: deriveVersesForPassage(defaultPassage, { club150: [], club300: [] }),
  }
  draft.value.weeks[idx] = { ...week, blocks: [...week.blocks, newBlock] }
}

/** Guess a sensible default passage for a new block being appended to
 *  week `idx`: pick up right after the previous non-empty block (either
 *  same week or an earlier week). Same-chapter continuation when there's
 *  room; jump to the next chapter of the same book when the previous
 *  ended at the chapter's last verse; jump to the next book when the
 *  previous ended at the book's last chapter. Falls back to a blank
 *  passage when there's no previous or the material projection is
 *  empty. */
function nextPassageAfter(weekIdx: number): PassageBlock['passage'] {
  const blank = { book: '', chapter: 0, startVerse: 0, endVerse: 0 }
  if (draft.value === null) return blank
  const prev = findPreviousBlockPassage(weekIdx)
  if (prev === null) return blank
  if (materialBooks.value.length === 0) return blank
  const chapterVerses = versesFor(prev.book, prev.chapter)
  const lastVerseOfChapter = chapterVerses[chapterVerses.length - 1]
  if (lastVerseOfChapter !== undefined && prev.endVerse < lastVerseOfChapter) {
    // Continue the same chapter from the next verse to its end.
    return {
      book: prev.book,
      chapter: prev.chapter,
      startVerse: prev.endVerse + 1,
      endVerse: lastVerseOfChapter,
    }
  }
  // Chapter finished — walk to the next chapter of the same book, or
  // the next book's first chapter.
  const bookChapters = chaptersFor(prev.book)
  const chapIdx = bookChapters.indexOf(prev.chapter)
  const nextChap = chapIdx >= 0 ? bookChapters[chapIdx + 1] : undefined
  if (nextChap !== undefined) {
    const vs = versesFor(prev.book, nextChap)
    if (vs.length > 0) {
      return { book: prev.book, chapter: nextChap, startVerse: vs[0]!, endVerse: vs[vs.length - 1]! }
    }
  }
  const bookIdx = materialBooks.value.indexOf(prev.book)
  const nextBook = bookIdx >= 0 ? materialBooks.value[bookIdx + 1] : undefined
  if (nextBook !== undefined) {
    const cs = chaptersFor(nextBook)
    const firstChap = cs[0]
    if (firstChap !== undefined) {
      const vs = versesFor(nextBook, firstChap)
      if (vs.length > 0) {
        return { book: nextBook, chapter: firstChap, startVerse: vs[0]!, endVerse: vs[vs.length - 1]! }
      }
    }
  }
  // Wrapped past the end of the material — nothing sensible to suggest.
  return blank
}

/** Walk backwards from `weekIdx` looking for the most recent block with
 *  a real passage. Same-week later blocks (blocks after the current
 *  append point) count — a user adding a second block wants it right
 *  after the first. */
function findPreviousBlockPassage(weekIdx: number): PassageBlock['passage'] | null {
  const s = draft.value
  if (s === null) return null
  const currentWeek = s.weeks[weekIdx]
  if (currentWeek !== undefined) {
    for (let bi = currentWeek.blocks.length - 1; bi >= 0; bi--) {
      const p = currentWeek.blocks[bi]?.passage
      if (p && p.book && p.chapter > 0 && p.startVerse > 0 && p.endVerse > 0) return p
    }
  }
  for (let i = weekIdx - 1; i >= 0; i--) {
    const w = s.weeks[i]
    if (!w) continue
    for (let bi = w.blocks.length - 1; bi >= 0; bi--) {
      const p = w.blocks[bi]?.passage
      if (p && p.book && p.chapter > 0 && p.startVerse > 0 && p.endVerse > 0) return p
    }
  }
  return null
}

function removeBlock(blockIdx: number) {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const idx = selection.value.weekIdx
  const week = draft.value.weeks[idx]
  if (!week || week.blocks.length <= 1) return
  const nextBlocks = week.blocks.filter((_, i) => i !== blockIdx)
  draft.value.weeks[idx] = { ...week, blocks: nextBlocks }
}

function toggleReviewWeek() {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const idx = selection.value.weekIdx
  const week = draft.value.weeks[idx]
  if (!week) return
  if (week.isReview) {
    // De-reviewing: rehydrate a block continuing right after the
    // previous week's last passage — the common case is filling in a
    // gap in the sequence, and defaulting to the next-passage saves
    // the user a full picker walk.
    const defaultPassage = nextPassageAfter(idx)
    draft.value.weeks[idx] = {
      ...week,
      isReview: false,
      blocks: [
        {
          passage: defaultPassage,
          verses: deriveVersesForPassage(defaultPassage, { club150: [], club300: [] }),
        },
      ],
    }
  } else {
    draft.value.weeks[idx] = { ...week, isReview: true, blocks: [] }
  }
}

// =============================================================================
// Range editor — chooses which weeks exist by picking a season start / end
// =============================================================================
//
// Per-row remove-week / add-week affordances are gone: middle weeks aren't
// removable (a gap in dates would break week indexing and the memorize
// algorithm's cumulative-count math), and the review toggle already handles
// "this week has no new verses". Season edges are edited via the range
// picker below — pick first and last week dates aligned to
// `meetingDayOfWeek`; anything outside is dropped, anything missing inside
// is materialised as a blank review week.

interface RangePendingState {
  startDate: string
  endDate: string
  weeksToDrop: number[]
  contentBearingDrops: number[]
}

type RangeState =
  | { kind: 'idle' }
  | { kind: 'editing' }
  | { kind: 'confirming'; pending: RangePendingState }

const rangeState = ref<RangeState>({ kind: 'idle' })
const rangeStartInput = ref('')
const rangeEndInput = ref('')
const rangeError = ref<string | null>(null)

function openRangeEditor() {
  if (draft.value === null || draft.value.weeks.length === 0) return
  rangeStartInput.value = draft.value.weeks[0]!.date
  rangeEndInput.value = draft.value.weeks[draft.value.weeks.length - 1]!.date
  rangeError.value = null
  rangeState.value = { kind: 'editing' }
}

function cancelRangeEdit() {
  rangeState.value = { kind: 'idle' }
  rangeError.value = null
}

/** Weekly date list from `start` through `end` (inclusive) at 7-day
 *  strides. Assumes both endpoints already land on
 *  `meetingDayOfWeek` — the validator upstream enforces that. */
function weeklyDatesBetween(start: string, end: string): string[] {
  const out: string[] = []
  let cur = start
  while (cur <= end) {
    out.push(cur)
    cur = shiftDate(cur, 7)
  }
  return out
}

/** ISO weekday index of an ISO `YYYY-MM-DD` in UTC (0 = Sun). Mirrors
 *  the same UTC-anchored parsing `lib/schedule.ts` uses so a Fri stays
 *  Fri regardless of the user's local timezone. */
function isoWeekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay()
}

function weekHasContent(w: ScheduleWeek): boolean {
  if (w.isReview) return false
  return w.blocks.some(
    (b) =>
      b.passage.book !== ''
      || b.passage.chapter !== 0
      || (b.verses.club150 && b.verses.club150.length > 0)
      || (b.verses.club300 && b.verses.club300.length > 0),
  )
}

function submitRangeEdit() {
  if (draft.value === null) return
  rangeError.value = null
  const start = rangeStartInput.value
  const end = rangeEndInput.value
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    rangeError.value = 'Both dates must be YYYY-MM-DD.'
    return
  }
  if (start > end) {
    rangeError.value = 'Season start must be on or before season end.'
    return
  }
  const dayIdx = DAYS_OF_WEEK.indexOf(draft.value.meetingDayOfWeek)
  if (isoWeekday(start) !== dayIdx || isoWeekday(end) !== dayIdx) {
    rangeError.value
      = `Both dates must fall on a ${fullDayName(draft.value.meetingDayOfWeek)}.`
    return
  }
  const dropIdx: number[] = []
  const contentDrops: number[] = []
  draft.value.weeks.forEach((w, i) => {
    if (w.date < start || w.date > end) {
      dropIdx.push(i)
      if (weekHasContent(w)) contentDrops.push(i)
    }
  })
  const pending: RangePendingState = {
    startDate: start,
    endDate: end,
    weeksToDrop: dropIdx,
    contentBearingDrops: contentDrops,
  }
  // Skip the extra confirm step when nothing meaningful is being lost.
  if (contentDrops.length === 0) {
    applyRangeEdit(pending)
    return
  }
  rangeState.value = { kind: 'confirming', pending }
}

function applyRangeEdit(pending: RangePendingState) {
  if (draft.value === null) return
  const targetDates = weeklyDatesBetween(pending.startDate, pending.endDate)
  const byDate = new Map<string, ScheduleWeek>()
  for (const w of draft.value.weeks) byDate.set(w.date, w)
  const nextWeeks: ScheduleWeek[] = targetDates.map((d) => {
    const existing = byDate.get(d)
    if (existing) return existing
    return { date: d, blocks: [], isReview: true }
  })
  draft.value = { ...draft.value, weeks: nextWeeks }
  // Selection may now point at a dropped index or a shifted one — drop
  // it rather than guess which week the user meant.
  selection.value = null
  rangeState.value = { kind: 'idle' }
  rangeError.value = null
}

function confirmRangeEdit() {
  if (rangeState.value.kind !== 'confirming') return
  applyRangeEdit(rangeState.value.pending)
}

// =============================================================================
// Meet editor state
// =============================================================================

const meetEndDateError = ref<string | null>(null)

/** Patch a single field on the selected meet in the draft. `id` is
 *  intentionally excluded — meets get a slug-derived id at creation
 *  and stay stable so the chain UI's gate references survive renames. */
function updateMeetField<K extends 'name' | 'startDate' | 'endDate' | 'location'>(
  key: K,
  value: string,
) {
  if (draft.value === null || selection.value?.kind !== 'meet') return
  const meet = draft.value.meets.find((m) => m.id === selection.value!.meetId)
  if (!meet) return
  const next: ScheduleMeet = { ...meet, [key]: value }
  // Inline endDate sanity check — surfaced as a hint, not a hard block,
  // so the user can correct without losing focus. Server-side
  // validateSchedule rejects on save if it's still inverted.
  if (next.endDate < next.startDate) {
    meetEndDateError.value = 'End date is before start date.'
  } else {
    meetEndDateError.value = null
  }
  draft.value = updateMeet(draft.value, meet.id, next)
}

function addMeetAfterLast() {
  if (draft.value === null) return
  const existingIds = draft.value.meets.map((m) => m.id)
  const today = new Date().toISOString().slice(0, 10)
  const blank: ScheduleMeet = {
    id: slugifyMeetId('new-meet', existingIds),
    name: 'New meet',
    startDate: today,
    endDate: today,
    location: '',
  }
  draft.value = addMeet(draft.value, blank)
  selectMeet(blank.id)
}

function removeSelectedMeet() {
  if (draft.value === null || selection.value?.kind !== 'meet') return
  const meetId = selection.value.meetId
  draft.value = removeMeet(draft.value, meetId)
  selection.value = null
  meetEndDateError.value = null
}

// Clear the meet end-date error whenever selection moves off the meet.
watch(
  () => selection.value?.kind,
  () => {
    meetEndDateError.value = null
  },
)

// =============================================================================
// Day-of-week shift + reset
// =============================================================================

/** Reset flow as a single discriminated union so structurally
 *  impossible combinations (e.g. dialog open AND banner showing AND
 *  busy spinner) can't arise. The three prior refs encoded the same
 *  state space with three booleans that, taken together, could
 *  represent 2^3 combos most of which had no UI meaning. */
type ResetState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'busy' }
  | { kind: 'done'; banner: string }

const resetState = ref<ResetState>({ kind: 'idle' })

const resetBanner = computed<string | null>(() =>
  resetState.value.kind === 'done' ? resetState.value.banner : null,
)

function onMeetingDayChange(newDay: DayOfWeek) {
  if (draft.value === null) return
  // Pure helper returns a new schedule with every week's date shifted
  // by the signed (newDow - oldDow) delta; meets are untouched (they
  // have their own weekend dates that don't track the practice day).
  draft.value = applyMeetingDayShift(draft.value, newDay)
}

function onResetClick() {
  resetState.value = { kind: 'confirming' }
}

function cancelReset() {
  resetState.value = { kind: 'idle' }
}

async function confirmReset() {
  if (resetState.value.kind === 'busy') return
  resetState.value = { kind: 'busy' }
  try {
    const { fallbackToBundled } = await api.deleteSchedule(materialId.value)
    // The Memorize-tab badge memoizes the per-material schedule for
    // the tab session; without explicit invalidation, navigating to
    // /memorize after a reset would keep computing the badge against
    // the user's (now-deleted) override. Same invariant on save below.
    invalidateScheduleCache(materialId.value)
    const banner = fallbackToBundled
      ? 'Reset complete — bundled schedule reapplied.'
      : 'No user customization existed; nothing to reset.'
    resetState.value = { kind: 'done', banner }
    await refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    resetState.value = { kind: 'idle' }
  }
}

/** Dirty iff the user has actually edited the draft. JSON.stringify
 *  is sound because both objects originate from the same construction
 *  path (server JSON → cloneSchedule), so key order matches. */
const isDirty = computed<boolean>(() => {
  if (saved.value === null || draft.value === null) return false
  return JSON.stringify(draft.value) !== JSON.stringify(saved.value)
})

async function refresh() {
  if (!materialId.value) return
  loading.value = true
  error.value = null
  try {
    // Fire both in parallel — the passage summary is per-material static
    // data, so a schedule refresh triggered by a save doesn't need to
    // block on re-fetching it, but it also doesn't cost anything to
    // re-request thanks to server-side caching.
    const [s, passages] = await Promise.all([
      api.getSchedule(materialId.value),
      api.getMaterialPassages(materialId.value).catch(
        // A missing / offline passages endpoint shouldn't gate the
        // whole editor — Full-tier fallback still renders, just without
        // the derived pill breakdown.
        () => ({ passages: [] }),
      ),
    ])
    saved.value = s
    draft.value = s === null ? null : cloneSchedule(s)
    materialPassages.value = passages.passages
    // Drop back to view mode after a refresh — a save commits then
    // returns here, and a route change that re-enters the view should
    // never land in edit by surprise.
    mode.value = 'view'
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function enterEdit() {
  if (saved.value === null) return
  draft.value = cloneSchedule(saved.value)
  mode.value = 'edit'
}

function discard() {
  // Restoring draft from saved is enough — the next enterEdit() reclones
  // anyway. Resetting `mode` first so a draft watcher (added in later
  // commits for live previews) sees the view-mode flag before the
  // reset hits.
  mode.value = 'view'
  if (saved.value !== null) draft.value = cloneSchedule(saved.value)
}

async function save() {
  if (draft.value === null || saving.value) return
  saving.value = true
  error.value = null
  try {
    await api.putSchedule(materialId.value, draft.value)
    invalidateScheduleCache(materialId.value)
    saved.value = cloneSchedule(draft.value)
    mode.value = 'view'
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

/** Browser-level guard for tab-close / refresh / external URL nav.
 *  The router-level guard below covers in-app nav. Both are needed
 *  because beforeunload doesn't fire for SPA route changes. */
function onBeforeUnload(ev: BeforeUnloadEvent) {
  if (!isDirty.value) return
  ev.preventDefault()
  // Modern browsers ignore the returnValue text but require it to be set.
  ev.returnValue = ''
}

onBeforeRouteLeave((_to, _from, next) => {
  if (!isDirty.value) {
    next()
    return
  }
  const ok = window.confirm(
    'You have unsaved schedule changes. Leave without saving?',
  )
  next(ok)
})

/** Esc dismisses the expand-in-place form. Any active input inside
 *  the form still handles Esc first (browsers cancel IME composition
 *  etc.), so this only fires when the schedule body itself has focus
 *  or nothing does — clearing selection collapses the form. */
function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (mode.value !== 'edit') return
  if (selection.value === null) return
  selection.value = null
  e.preventDefault()
}

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('keydown', onKeyDown)
  await refresh()
  // After the schedule has rendered, bring the current week into view —
  // a 30+ week list otherwise leaves the user at the top, mid-season.
  // No-op when the season hasn't started or has already ended.
  await nextTick()
  document
    .querySelector('.sched .wk.is-current')
    ?.scrollIntoView({ block: 'center', behavior: 'instant' })
})

// onBeforeRouteLeave is component-scoped and clears itself; the
// window listeners need explicit removal.
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('keydown', onKeyDown)
})

/** Focus the first editable input inside the freshly-expanded form so
 *  Tab / Enter work without the user having to click a field. Fires
 *  after every selection change (week or meet). */
watch(selection, async (sel) => {
  if (sel === null || mode.value !== 'edit') return
  await nextTick()
  const selector
    = sel.kind === 'week'
      ? '.wk.is-selected + .wk-form input, .wk.is-selected + .wk-form select'
      : '.meet.is-selected + .meet-form input, .meet.is-selected + .meet-form select'
  const first = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector)
  first?.focus()
})

function backToSettings() {
  void router.push('/settings/materials')
}
</script>

<template>
  <div class="schedule-editor">
    <div v-if="error" class="banner banner-error">{{ error }}</div>

    <div v-if="loading" class="status">Loading schedule…</div>

    <div v-else-if="saved === null" class="status">
      <h2>No schedule for this material</h2>
      <p>
        This material doesn't ship a published schedule yet, and you haven't
        created a custom one. Memorize will fall back to sequential ordering.
      </p>
      <button type="button" class="back-button" @click="backToSettings">
        ← Back to /settings/materials
      </button>
    </div>

    <template v-else-if="display !== null">
      <header class="editor-header">
        <div class="title-row">
          <button
            type="button"
            class="back-link"
            aria-label="Back to settings"
            @click="backToSettings"
          >
            ←
          </button>
          <div class="title-block">
            <h2>{{ display.title }}</h2>
            <p class="subtitle">
              {{ display.season }} · practices {{
                fullDayName(display.meetingDayOfWeek)
              }}s ·
              {{ display.weeks.length }} weeks ·
              {{ display.meets.length }} quiz {{ display.meets.length === 1 ? 'meet' : 'meets' }}
            </p>
          </div>
        </div>

        <div class="mode-controls">
          <template v-if="mode === 'view'">
            <button
              type="button"
              class="secondary"
              :disabled="resetState.kind === 'busy'"
              @click="onResetClick"
            >
              Reset to default
            </button>
            <button type="button" class="primary" @click="enterEdit">
              Edit schedule
            </button>
          </template>
          <template v-else>
            <div
              class="coverage-badge"
              :class="{
                'coverage-ok': coverageTotalIssues === 0 && !coverageResult.materialEmpty,
                'coverage-bad': coverageTotalIssues > 0,
                'coverage-unknown': coverageResult.materialEmpty,
              }"
              role="status"
              :aria-label="coverageBadgeAria"
              :title="coverageBadgeAria"
            >
              <template v-if="coverageResult.materialEmpty">? no material data</template>
              <template v-else-if="coverageTotalIssues === 0">✓ covers material</template>
              <template v-else>
                ⚠ {{ coverageTotalIssues }}
                coverage {{ coverageTotalIssues === 1 ? 'issue' : 'issues' }}
              </template>
            </div>
            <button
              type="button"
              class="secondary"
              :disabled="saving"
              @click="discard"
            >
              Discard
            </button>
            <button
              type="button"
              class="primary"
              :disabled="!isDirty || saving"
              @click="save"
            >
              {{ saving ? 'Saving…' : 'Save schedule' }}
            </button>
          </template>
        </div>
      </header>

      <p v-if="resetBanner" class="banner banner-info">{{ resetBanner }}</p>

      <details
        v-if="mode === 'edit' && coverageTotalIssues > 0"
        class="coverage-detail"
      >
        <summary>
          {{ coverageTotalIssues }}
          {{ coverageTotalIssues === 1 ? 'coverage issue' : 'coverage issues' }}
          — click to expand
        </summary>
        <ul v-if="coverageResult.gaps.length" class="coverage-list">
          <li v-for="(g, i) in coverageResult.gaps" :key="`gap-${i}`">
            <span class="coverage-tag coverage-tag-gap">gap</span>
            {{ formatCoverageRange(g) }}
          </li>
        </ul>
        <ul v-if="coverageResult.overlaps.length" class="coverage-list">
          <li v-for="(o, i) in coverageResult.overlaps" :key="`over-${i}`">
            <span class="coverage-tag coverage-tag-overlap">overlap</span>
            {{ formatCoverageRange(o) }}
            <span class="coverage-weeks">
              (weeks {{ o.weekIdxs.map((w) => w + 1).join(', ') }})
            </span>
          </li>
        </ul>
      </details>

      <div v-if="mode === 'edit'" class="day-picker">
        <label>
          <span>Practices on</span>
          <select
            :value="display.meetingDayOfWeek"
            @change="onMeetingDayChange(($event.target as HTMLSelectElement).value as DayOfWeek)"
          >
            <option v-for="d in DAYS_OF_WEEK" :key="d" :value="d">
              {{ fullDayName(d) }}s
            </option>
          </select>
        </label>
        <button
          type="button"
          class="range-button"
          @click="openRangeEditor"
        >
          Edit season range…
        </button>
        <p class="day-picker-hint">
          Changing the practice day shifts every practice week by the
          same delta. Quiz meets keep their own weekend dates. Season
          range picks the first and last week — anything outside is
          dropped, gaps inside fill in as review weeks.
        </p>
      </div>

      <div
        v-if="mode === 'edit' && rangeState.kind === 'editing'"
        class="range-editor"
        role="dialog"
        aria-label="Edit season range"
      >
        <div class="range-fields">
          <label class="field">
            <span>Season start ({{ fullDayName(display.meetingDayOfWeek) }})</span>
            <input
              v-model="rangeStartInput"
              type="date"
            />
          </label>
          <label class="field">
            <span>Season end ({{ fullDayName(display.meetingDayOfWeek) }})</span>
            <input
              v-model="rangeEndInput"
              type="date"
            />
          </label>
        </div>
        <p v-if="rangeError" class="field-error" role="alert">
          {{ rangeError }}
        </p>
        <div class="form-actions">
          <button type="button" class="secondary" @click="cancelRangeEdit">
            Cancel
          </button>
          <button type="button" class="primary" @click="submitRangeEdit">
            Apply
          </button>
        </div>
      </div>

      <section class="editor-body" :class="{ 'is-editing': mode === 'edit' }">
        <!-- View + edit modes share the responsive .sched layout from
             the redesign spec §6. Container queries drive three regimes
             off the wrapper's own width (Ledger ≥790px, Condensed
             520-789px, Cards <520px). In edit mode, clicking a week or
             meet expands the row's form inline (spec §3.5 — no side
             pane, "nothing to overflow"). Add-week / Add-meet buttons
             live at the bottom of the body. -->
        <div class="sched">
          <div class="col-head" role="row">
            <span role="columnheader">Date</span>
            <span role="columnheader">Passage</span>
            <span role="columnheader">Club 150</span>
            <span role="columnheader">Club 300</span>
          </div>
          <div class="sched-body">
            <template v-for="row in rows" :key="row.key">
              <h3 v-if="row.kind === 'month'" class="month">{{ row.label }}</h3>
              <template v-else-if="row.kind === 'week'">
                <article
                  class="wk"
                  :class="{
                    'is-current': row.isCurrent,
                    'is-review': row.week.isReview,
                    'is-selected': mode === 'edit' && isWeekRowSelected(row.weekIdx),
                    'is-editable': mode === 'edit',
                    'is-issue': mode === 'edit' && coverageIssueWeeks.has(row.weekIdx),
                  }"
                  :style="weekGridStyle(row.week)"
                  :aria-current="row.isCurrent ? 'date' : undefined"
                  :tabindex="mode === 'edit' ? 0 : undefined"
                  @click="mode === 'edit' ? selectWeek(row.weekIdx) : null"
                  @keydown.enter="mode === 'edit' ? selectWeek(row.weekIdx) : null"
                >
                  <span class="c-date">- {{ row.ordinal }}</span>
                  <template v-if="row.week.isReview">
                    <span class="c-pass c-review">Review</span>
                  </template>
                  <template
                    v-for="(block, bi) in row.week.blocks"
                    v-else
                    :key="bi"
                  >
                    <span class="c-pass">{{ formatPassage(block.passage) }}</span>
                    <div class="c-150">
                      <span class="lbl">150</span>
                      <div class="vals">
                        <span
                          v-for="n in derivedVerseNumbers(block, 150)"
                          :key="n"
                          class="v"
                        >{{ n }}</span>
                      </div>
                    </div>
                    <div class="c-300">
                      <span class="lbl">300</span>
                      <div class="vals">
                        <span
                          v-for="n in derivedVerseNumbers(block, 300)"
                          :key="n"
                          class="v"
                        >{{ n }}</span>
                      </div>
                    </div>
                  </template>
                </article>
                <!-- Expand-in-place form: sits between rows and pushes
                     the rest of the body down. Left accent rule + tinted
                     background make the expansion obvious at every
                     container width. -->
                <form
                  v-if="mode === 'edit' && isWeekRowSelected(row.weekIdx)"
                  class="wk-form"
                  @submit.prevent
                >
                  <p class="detail-date">
                    {{ formatTimelineDate(row.week.date) }}
                  </p>
                  <label class="toggle">
                    <input
                      type="checkbox"
                      :checked="row.week.isReview"
                      @change="toggleReviewWeek"
                    />
                    <span>Review week (no new verses introduced)</span>
                  </label>
                  <template v-if="!row.week.isReview">
                    <template
                      v-for="(block, bi) in row.week.blocks"
                      :key="bi"
                    >
                      <fieldset class="passage">
                        <legend>
                          Passage {{ row.week.blocks.length > 1 ? bi + 1 : '' }}
                          <button
                            v-if="row.week.blocks.length > 1"
                            type="button"
                            class="mini-danger"
                            aria-label="Remove this passage"
                            @click="removeBlock(bi)"
                          >
                            ×
                          </button>
                        </legend>
                        <template v-if="materialBooks.length > 0">
                          <label class="field passage-book">
                            <span>Book</span>
                            <select
                              :value="block.passage.book"
                              @change="updateBlockPassage(bi, { book: ($event.target as HTMLSelectElement).value })"
                            >
                              <option value="">— select —</option>
                              <option
                                v-for="b in materialBooks"
                                :key="b"
                                :value="b"
                              >
                                {{ b }}
                              </option>
                            </select>
                          </label>
                          <label class="field passage-chapter">
                            <span>Chapter</span>
                            <select
                              :value="block.passage.chapter || ''"
                              :disabled="!block.passage.book"
                              @change="updateBlockPassage(bi, { chapter: Number(($event.target as HTMLSelectElement).value) || 0 })"
                            >
                              <option value="">— select —</option>
                              <option
                                v-for="c in chaptersFor(block.passage.book)"
                                :key="c"
                                :value="c"
                              >
                                {{ c }}
                              </option>
                            </select>
                          </label>
                          <label class="field passage-start">
                            <span>Start verse</span>
                            <select
                              :value="block.passage.startVerse || ''"
                              :disabled="!block.passage.chapter"
                              @change="updateBlockPassage(bi, { startVerse: Number(($event.target as HTMLSelectElement).value) || 0 })"
                            >
                              <option value="">— select —</option>
                              <option
                                v-for="v in versesFor(block.passage.book, block.passage.chapter)"
                                :key="v"
                                :value="v"
                              >
                                {{ v }}
                              </option>
                            </select>
                          </label>
                          <label class="field passage-end">
                            <span>End verse</span>
                            <select
                              :value="block.passage.endVerse || ''"
                              :disabled="!block.passage.startVerse"
                              @change="updateBlockPassage(bi, { endVerse: Number(($event.target as HTMLSelectElement).value) || 0 })"
                            >
                              <option value="">— select —</option>
                              <option
                                v-for="v in versesFor(block.passage.book, block.passage.chapter).filter((n) => n >= block.passage.startVerse)"
                                :key="v"
                                :value="v"
                              >
                                {{ v }}
                              </option>
                            </select>
                          </label>
                        </template>
                        <template v-else>
                          <label class="field passage-book">
                            <span>Book</span>
                            <input
                              type="text"
                              :value="block.passage.book"
                              @input="updateBlockPassageField(bi, 'book', ($event.target as HTMLInputElement).value)"
                            />
                          </label>
                          <label class="field passage-chapter">
                            <span>Chapter</span>
                            <input
                              type="number"
                              min="1"
                              :value="block.passage.chapter || ''"
                              @input="updateBlockPassageField(bi, 'chapter', Number(($event.target as HTMLInputElement).value) || 0)"
                            />
                          </label>
                          <label class="field passage-start">
                            <span>Start verse</span>
                            <input
                              type="number"
                              min="1"
                              :value="block.passage.startVerse || ''"
                              @input="updateBlockPassageField(bi, 'startVerse', Number(($event.target as HTMLInputElement).value) || 0)"
                            />
                          </label>
                          <label class="field passage-end">
                            <span>End verse</span>
                            <input
                              type="number"
                              min="1"
                              :value="block.passage.endVerse || ''"
                              @input="updateBlockPassageField(bi, 'endVerse', Number(($event.target as HTMLInputElement).value) || 0)"
                            />
                          </label>
                        </template>
                      </fieldset>
                      <div class="verses-summary" aria-label="Verse numbers">
                        <div class="verses-row">
                          <span class="verses-label club-150">
                            150 · {{ cumulativeCount(block, 'club150') }}
                          </span>
                          <div class="verses-vals">
                            <span
                              v-for="n in derivedVerseNumbers(block, 150)"
                              :key="n"
                              class="v v-150"
                            >{{ n }}</span>
                            <span
                              v-if="!derivedVerseNumbers(block, 150).length"
                              class="verses-empty"
                            >—</span>
                          </div>
                        </div>
                        <div class="verses-row">
                          <span class="verses-label club-300">
                            300 · {{ cumulativeCount(block, 'club300') }}
                          </span>
                          <div class="verses-vals">
                            <span
                              v-for="n in derivedVerseNumbers(block, 300)"
                              :key="n"
                              class="v v-300"
                            >{{ n }}</span>
                            <span
                              v-if="!derivedVerseNumbers(block, 300).length"
                              class="verses-empty"
                            >—</span>
                          </div>
                        </div>
                        <div class="verses-row verses-row-full">
                          <span class="verses-label club-full">
                            Full · {{ cumulativeCount(block, 'full') }}
                          </span>
                        </div>
                      </div>
                    </template>
                    <button
                      type="button"
                      class="add-block"
                      @click="addPassageBlock"
                    >
                      + Add a passage
                    </button>
                  </template>
                </form>
              </template>
              <template v-else-if="row.kind === 'meet'">
                <div
                  class="meet"
                  :class="{
                    'is-selected': mode === 'edit' && isMeetRowSelected(row.meet.id),
                    'is-editable': mode === 'edit',
                  }"
                  :tabindex="mode === 'edit' ? 0 : undefined"
                  @click="mode === 'edit' ? selectMeet(row.meet.id) : null"
                  @keydown.enter="mode === 'edit' ? selectMeet(row.meet.id) : null"
                >
                  <span class="meet-dates">{{ row.dateRange }}</span>
                  <span class="meet-name">{{ row.meet.name }}</span>
                  <span v-if="row.meet.location" class="meet-location">
                    · {{ row.meet.location }}
                  </span>
                </div>
                <form
                  v-if="mode === 'edit' && isMeetRowSelected(row.meet.id)"
                  class="meet-form"
                  @submit.prevent
                >
                  <fieldset class="meet-fields">
                    <legend>Meet</legend>
                    <label class="field">
                      <span>Name</span>
                      <input
                        type="text"
                        :value="row.meet.name"
                        @input="updateMeetField('name', ($event.target as HTMLInputElement).value)"
                      />
                    </label>
                    <label class="field">
                      <span>Start date</span>
                      <input
                        type="date"
                        :value="row.meet.startDate"
                        @input="updateMeetField('startDate', ($event.target as HTMLInputElement).value)"
                      />
                    </label>
                    <label class="field">
                      <span>End date</span>
                      <input
                        type="date"
                        :value="row.meet.endDate"
                        @input="updateMeetField('endDate', ($event.target as HTMLInputElement).value)"
                      />
                    </label>
                    <label class="field meet-location">
                      <span>Location (optional, may be "TBD")</span>
                      <input
                        type="text"
                        :value="row.meet.location"
                        @input="updateMeetField('location', ($event.target as HTMLInputElement).value)"
                      />
                    </label>
                    <p v-if="meetEndDateError" class="field-error" role="alert">
                      {{ meetEndDateError }}
                    </p>
                  </fieldset>
                  <div class="form-actions">
                    <button type="button" class="danger" @click="removeSelectedMeet">
                      Remove this meet
                    </button>
                  </div>
                </form>
              </template>
            </template>
          </div>
          <div v-if="mode === 'edit'" class="add-row">
            <button type="button" class="add-week" @click="addMeetAfterLast">
              + Add a meet
            </button>
          </div>
        </div>

      </section>
    </template>

    <ConfirmDialog
      v-if="resetState.kind === 'confirming' || resetState.kind === 'busy'"
      title="Reset to bundled schedule?"
      confirm-label="Reset"
      destructive
      :busy="resetState.kind === 'busy'"
      @confirm="confirmReset"
      @cancel="cancelReset"
    >
      <p>
        This discards your customizations for this material and reapplies
        the bundled schedule. Existing memorize progress is unaffected.
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      v-if="rangeState.kind === 'confirming'"
      title="Drop weeks with content?"
      confirm-label="Drop them"
      destructive
      @confirm="confirmRangeEdit"
      @cancel="cancelRangeEdit"
    >
      <p>
        The new range removes {{ rangeState.pending.contentBearingDrops.length }}
        week{{ rangeState.pending.contentBearingDrops.length === 1 ? '' : 's' }}
        with a passage or verse numbers assigned. You'll lose that data
        for these weeks.
      </p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.schedule-editor {
  width: 100%;
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.banner {
  padding: 0.75rem 1rem;
  border-radius: 6px;
}

.banner-error {
  background: var(--color-error-bg);
  color: var(--color-error);
}

.banner-info {
  background: var(--color-accent-soft);
  color: var(--color-text);
}

.day-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  padding: 0.6rem 1rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.day-picker label {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
}

.day-picker select {
  padding: 0.3rem 0.5rem;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.9rem;
}

.day-picker-hint {
  margin: 0;
  flex: 1 1 18rem;
  font-size: 0.8rem;
  color: var(--color-muted);
  font-style: italic;
}

.range-button {
  padding: 0.3rem 0.7rem;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.range-button:hover {
  border-color: var(--color-accent);
}

.range-editor {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent);
  border-radius: 6px;
}

.range-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem 1rem;
}

@media (max-width: 480px) {
  .range-fields {
    grid-template-columns: 1fr;
  }
}


.status {
  padding: 2rem;
  text-align: center;
  color: var(--color-muted);
}

.status h2 {
  margin: 0 0 0.5rem;
  color: var(--color-text);
}

.editor-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.title-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.back-link {
  background: none;
  border: none;
  color: var(--color-muted);
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0.25rem 0.4rem;
  border-radius: 4px;
  line-height: 1;
}

.back-link:hover {
  color: var(--color-text);
  background: var(--color-accent-soft);
}

.title-block h2 {
  margin: 0;
  font-size: 1.3rem;
  font-weight: 600;
}

.subtitle {
  margin: 0.2rem 0 0;
  font-size: 0.85rem;
  color: var(--color-muted);
}

.mode-controls {
  display: inline-flex;
  gap: 0.5rem;
  align-items: center;
}

/* Coverage badge sits beside Discard / Save so the user sees the
 * coverage state without scrolling. The banner below carries the
 * detail; the badge is the summary. */
.coverage-badge {
  padding: 0.35rem 0.65rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 600;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  white-space: nowrap;
}

.coverage-badge.coverage-ok {
  border-color: var(--color-success);
  background: var(--color-success-bg);
  color: var(--color-success);
}

.coverage-badge.coverage-bad {
  border-color: var(--color-error);
  background: var(--color-error-bg);
  color: var(--color-error);
}

.coverage-badge.coverage-unknown {
  color: var(--color-muted);
  font-style: italic;
}

.coverage-detail {
  padding: 0.6rem 0.9rem;
  background: var(--color-error-bg);
  border: 1px solid var(--color-error);
  border-radius: 6px;
  color: var(--color-error);
}

.coverage-detail > summary {
  cursor: pointer;
  font-weight: 600;
}

.coverage-list {
  list-style: none;
  padding: 0.5rem 0 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  color: var(--color-text);
  font-size: 0.85rem;
}

.coverage-list li {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.coverage-tag {
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.05rem 0.4rem;
  border-radius: 4px;
}

.coverage-tag-gap {
  background: var(--color-error);
  color: var(--color-on-accent);
}

.coverage-tag-overlap {
  background: var(--color-grade-hard);
  color: var(--color-on-accent);
}

.coverage-weeks {
  color: var(--color-muted);
  font-size: 0.8rem;
}

.sched .wk.is-issue {
  box-shadow: inset 3px 0 0 var(--color-error);
}

button.primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
  border: none;
  border-radius: 4px;
  padding: 0.45rem 1rem;
  font-size: 0.9rem;
  font-family: inherit;
  cursor: pointer;
}

button.primary:disabled {
  background: var(--color-border);
  color: var(--color-muted);
  cursor: not-allowed;
}

button.secondary {
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 0.45rem 1rem;
  font-size: 0.9rem;
  font-family: inherit;
  cursor: pointer;
}

button.secondary:hover:not(:disabled) {
  border-color: var(--color-accent);
}

.back-button {
  margin-top: 1rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.4rem 0.9rem;
  font-size: 0.9rem;
  font-family: inherit;
  cursor: pointer;
  color: var(--color-text);
}

.back-button:hover {
  border-color: var(--color-accent);
}

/* View mode: single-column flow (the .sched IS the detail).
 * Edit mode: two-column grid with the form pane on the right (and the
 * legacy table on the left, until the spec's phase 5 lands).
 * The `.is-editing` class on `.editor-body` flips between them. */
.editor-body {
  display: block;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.25rem 1.5rem;
}

/* =============================================================================
 * View-mode schedule (`.sched`) — redesign spec §3, §6.
 *
 * Container-query driven. Three regimes off the wrapper's own width:
 *   base (< 520px)   — cards; date is a badge, verses are pills
 *   ≥ 520px (Cond.)  — date rail on the left, passage + pills stacked right
 *   ≥ 790px (Ledger) — full 4-column printable ledger, comma-list verses
 *
 * Multi-passage weeks (blocks.length > 1) share the date cell across all
 * blocks: --wk-blocks spans them in Ledger, --wk-rows in Condensed. Review
 * weeks render "Review" in the passage slot only.
 *
 * TODO(print): out of scope for this pass. Future: @media print that
 * forces the Ledger regime regardless of container width and hides app
 * chrome; see spec §3.6.
 * ============================================================================= */

.sched {
  /* Reflow off .sched's own width, not the viewport, so the layout is
   * correct in a split pane or any embedding. */
  container-type: inline-size;
  min-width: 0;
}

/* ---------- BASE: mobile-first Cards regime ---------- */
.sched .col-head {
  /* Column-headers row only makes sense in Ledger; hidden otherwise. */
  display: none;
}

.sched-body {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.5rem 0;
}

.sched .month {
  margin: 1rem 0 0.15rem;
  font-family: Georgia, 'Times New Roman', serif;
  font-style: italic;
  font-size: 1rem;
  font-weight: 500;
  color: var(--color-text);
}

.sched .month:first-child {
  margin-top: 0.25rem;
}

.sched .wk {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  padding: 0.75rem 0.85rem;
}

.sched .wk.is-review {
  border-style: dashed;
  background: transparent;
}

.sched .wk.is-current {
  border-color: var(--color-accent);
  box-shadow: inset 3px 0 0 var(--color-accent);
}

.sched .c-date {
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-muted);
}

.sched .wk.is-current .c-date {
  color: var(--color-accent);
}

.sched .c-pass {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1.05rem;
  font-weight: 500;
  color: var(--color-text);
  line-height: 1.2;
}

.sched .c-review {
  color: var(--color-muted);
  font-style: italic;
}

.sched .c-150,
.sched .c-300 {
  display: flex;
  gap: 0.55rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.sched .lbl {
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  flex: 0 0 1.9rem;
}

/* Club colour convention — traditional Bible-quiz palette is Club 150 =
 * yellow highlighter and Club 300 = blue highlighter. This app doesn't
 * use full-saturation highlighter tones, but the hues are kept on the
 * correct sides so 300 reads blue-ish and 150 reads warm; the previous
 * app palette (150 blue, 300 orange) was the direct swap of tradition
 * and confused users who were used to marking their own Bibles. */
.sched .c-150 .lbl {
  color: var(--color-grade-hard);
}

.sched .c-300 .lbl {
  color: var(--color-grade-easy);
}

.sched .vals {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.sched .v {
  /* Club 150 pill — warm, on the yellow side of the traditional
   * palette. Ledger strips this styling and swaps in a comma-separated
   * inline flow (see below). */
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
  padding: 0.1rem 0.4rem;
  border-radius: 5px;
  background: var(--color-grade-hard-bg);
  color: var(--color-grade-hard);
  line-height: 1.25;
}

.sched .c-300 .v {
  background: var(--color-grade-easy-bg);
  color: var(--color-grade-easy);
}

.sched .meet {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.6rem;
  align-items: baseline;
  padding: 0.55rem 0.8rem;
  background: var(--color-grade-hard-bg);
  border-radius: 8px;
  color: var(--color-text);
}

.sched .meet .meet-dates {
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  color: var(--color-grade-hard);
  font-weight: 600;
}

.sched .meet .meet-name {
  font-weight: 600;
}

.sched .meet .meet-location {
  color: var(--color-muted);
  font-weight: 400;
}

/* ---------- CONDENSED: 520–789px, date rail + stacked passage / pills ---------- */
@container (min-width: 520px) {
  .sched-body {
    gap: 0.4rem;
  }
  .sched .wk {
    display: grid;
    grid-template-columns: 4.5rem 1fr;
    gap: 0.4rem 1rem;
    align-items: baseline;
  }
  .sched .wk .c-date {
    /* Date spans every child row in column 1. For a single-passage
     * week --wk-rows is 3 (pass / 150 / 300); for review it's 3 too
     * (harmless — only the passage child fills the span). */
    grid-column: 1;
    grid-row: 1 / span var(--wk-rows, 3);
    align-self: start;
  }
  .sched .wk .c-pass,
  .sched .wk .c-150,
  .sched .wk .c-300 {
    grid-column: 2;
  }
}

/* ---------- LEDGER: ≥ 790px, full 4-column printable table ---------- */
@container (min-width: 790px) {
  .sched .col-head {
    display: grid;
    grid-template-columns: 5rem 1.5fr 2fr 2fr;
    gap: 0 1rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .sched-body {
    gap: 0;
    padding: 0;
  }
  .sched .month {
    padding: 0.9rem 1rem 0.25rem;
    font-size: 0.75rem;
    font-style: normal;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .sched .month:first-child {
    padding-top: 0.4rem;
  }
  .sched .wk {
    display: grid;
    grid-template-columns: 5rem 1.5fr 2fr 2fr;
    gap: 0.3rem 1rem;
    align-items: baseline;
    background: transparent;
    /* Explicit `0` on the non-top sides (rather than `border: none`)
     * so the review override — which sets `border-style` back to
     * solid to cancel the base-regime dashed card border — can't
     * silently re-inflate to `medium` (3px) here. */
    border: 0 solid var(--color-border);
    border-top-width: 1px;
    border-radius: 0;
    padding: 0.5rem 1rem;
    box-shadow: none;
  }
  .sched .wk.is-review {
    border-style: solid;
  }
  .sched .wk.is-current {
    background: var(--color-accent-soft);
    box-shadow: inset 3px 0 0 var(--color-accent);
  }
  .sched .wk .c-date {
    grid-column: 1;
    /* Multi-passage weeks: one ledger row per block, date spans them. */
    grid-row: 1 / span var(--wk-blocks, 1);
    font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
    font-size: 0.78rem;
    letter-spacing: 0;
    text-transform: none;
    color: var(--color-muted);
  }
  .sched .wk .c-pass {
    grid-column: 2;
    font-size: 0.95rem;
  }
  .sched .wk .c-150 {
    grid-column: 3;
  }
  .sched .wk .c-300 {
    grid-column: 4;
  }
  .sched .lbl {
    /* Labels live in the header row in Ledger mode. */
    display: none;
  }
  .sched .vals {
    display: block;
  }
  /* Scope to view-mode `.vals` explicitly so the edit-form's
   * `.verses-summary .v` pills keep their pill styling — the flat
   * `.sched .v` selector previously stripped the background and
   * injected commas everywhere .sched wrapped, including the form. */
  .sched .vals .v {
    /* Strip pill styling → inline comma list. `::after ", "` gives
     * the PDF-faithful comma separator without breaking the mono grid. */
    background: transparent;
    padding: 0;
    color: var(--color-text);
    font-size: 0.8rem;
  }
  .sched .c-300 .vals .v {
    background: transparent;
    color: var(--color-text);
  }
  .sched .vals .v:not(:last-child)::after {
    content: ', ';
    white-space: pre;
  }
  .sched .meet {
    margin: 0;
    padding: 0.55rem 1rem;
    border-radius: 0;
  }
}

/* =============================================================================
 * Edit mode — expand-in-place editor (spec §3.5).
 *
 * Selected week/meet expands into an inline form that sits between rows
 * and pushes the rest of the body down. Left accent rule + tinted
 * background make the expansion obvious at every container width.
 * No side pane → nothing to overflow.
 * ============================================================================= */

.sched .wk.is-editable,
.sched .meet.is-editable {
  cursor: pointer;
  transition: background-color 120ms ease;
}

.sched .wk.is-editable:hover,
.sched .meet.is-editable:hover {
  background: var(--color-bg);
}

.sched .wk.is-editable:focus-visible,
.sched .meet.is-editable:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.sched .wk.is-selected,
.sched .meet.is-selected {
  background: var(--color-accent-soft);
  box-shadow: inset 3px 0 0 var(--color-accent);
}

.wk-form,
.meet-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 1.25rem;
  margin: 0;
  background: var(--color-accent-soft);
  border-left: 3px solid var(--color-accent);
  /* Soft slide-in on expand. `prefers-reduced-motion` disables it
   * below so users who opted out of motion don't see the animation. */
  animation: form-slide-in 140ms ease-out;
  transform-origin: top;
}

@keyframes form-slide-in {
  from {
    opacity: 0;
    transform: scaleY(0.96);
  }
  to {
    opacity: 1;
    transform: scaleY(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .wk-form,
  .meet-form {
    animation: none;
  }
}

@container (min-width: 520px) {
  .wk-form,
  .meet-form {
    padding: 1.25rem 1.5rem;
  }
}

.detail-date {
  margin: 0;
  color: var(--color-muted);
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.85rem;
  letter-spacing: 0.04em;
}

/* Verse numbers block — read-only summary of what's covered by the
 * passage, split into Club 150 / Club 300 / Full. The engine derives
 * Full per-block (passage range minus 150 ∪ 300); the editor mirrors
 * that so the user sees exactly what the algorithm will pick up. */
.verses-summary {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.6rem 0.8rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.verses-row {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.verses-label {
  flex: 0 0 5rem;
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.verses-label.club-150 {
  color: var(--color-grade-hard);
}

.verses-label.club-300 {
  color: var(--color-grade-easy);
}

.verses-label.club-full {
  color: var(--color-muted);
}

.verses-vals {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.verses-vals .v {
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
  padding: 0.1rem 0.4rem;
  border-radius: 5px;
  line-height: 1.25;
}

.verses-vals .v-150 {
  background: var(--color-grade-hard-bg);
  color: var(--color-grade-hard);
}

.verses-vals .v-300 {
  background: var(--color-grade-easy-bg);
  color: var(--color-grade-easy);
}

.verses-empty {
  color: var(--color-muted);
  font-style: italic;
  font-size: 0.85rem;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

.add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
  padding: 0.5rem 0;
}

.add-week {
  background: none;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  padding: 0.4rem 0.75rem;
  color: var(--color-muted);
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.add-week:hover {
  border-color: var(--color-accent);
  color: var(--color-text);
}

.add-block {
  align-self: flex-start;
  background: none;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  padding: 0.35rem 0.75rem;
  color: var(--color-muted);
  font-family: inherit;
  font-size: 0.82rem;
  cursor: pointer;
}

.add-block:hover {
  border-color: var(--color-accent);
  color: var(--color-text);
}

.mini-danger {
  margin-left: 0.4rem;
  border: none;
  background: none;
  color: var(--color-grade-again);
  font-size: 1rem;
  line-height: 1;
  padding: 0 0.3rem;
  cursor: pointer;
  border-radius: 4px;
}

.mini-danger:hover {
  background: var(--color-error-bg);
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.9rem;
}

.toggle input[type='checkbox'] {
  accent-color: var(--color-accent);
}

fieldset.passage,
fieldset.verses,
fieldset.meet-fields {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem 1rem;
}

fieldset legend {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-muted);
  padding: 0 0.3rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
}

.field span {
  color: var(--color-muted);
  font-size: 0.78rem;
}

.field input {
  padding: 0.35rem 0.55rem;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.9rem;
}

.field input:focus,
.field select:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
  border-color: var(--color-accent);
}

.field select {
  padding: 0.35rem 0.55rem;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.9rem;
}

.field select:disabled {
  color: var(--color-muted);
  cursor: not-allowed;
}

.passage-book {
  grid-column: 1 / -1;
}

fieldset.verses {
  grid-template-columns: 1fr;
}

.field-error {
  margin: 0;
  font-size: 0.82rem;
  color: var(--color-error);
}

.field-hint {
  margin: 0;
  font-size: 0.78rem;
  font-style: italic;
  color: var(--color-muted);
}

button.danger {
  align-self: flex-start;
  background: var(--color-grade-again);
  color: var(--color-on-accent);
  border: none;
  border-radius: 4px;
  padding: 0.45rem 0.9rem;
  font-size: 0.85rem;
  font-family: inherit;
  cursor: pointer;
}

button.danger:hover {
  filter: brightness(1.1);
}

.meet-location {
  grid-column: 1 / -1;
}
</style>
