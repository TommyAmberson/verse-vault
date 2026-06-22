<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'

import { api } from '@/api'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { invalidateScheduleCache } from '@/lib/badges'
import {
  DAYS_OF_WEEK,
  type DayOfWeek,
  type Schedule,
  type ScheduleMeet,
  type ScheduleWeek,
  addMeet,
  addWeekAt,
  applyMeetingDayShift,
  cloneSchedule,
  englishOrdinal,
  formatPassage,
  formatVerseList,
  fullDayName,
  isoWeekStart,
  monthName,
  parseVerseList,
  removeMeet,
  removeWeekAt,
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

function selectWeek(weekIdx: number) {
  selection.value = { kind: 'week', weekIdx }
}

function selectMeet(meetId: string) {
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

const selectedWeek = computed<ScheduleWeek | null>(() => {
  if (selection.value?.kind !== 'week') return null
  return display.value?.weeks[selection.value.weekIdx] ?? null
})

const selectedMeet = computed<ScheduleMeet | null>(() => {
  if (selection.value?.kind !== 'meet') return null
  return display.value?.meets.find((m) => m.id === selection.value!.meetId) ?? null
})

// =============================================================================
// Per-week editor state
// =============================================================================

/** Local text mirrors for the per-tier comma-separated verse inputs.
 *  Bound directly via v-model so the user sees what they typed before
 *  the parser runs; on blur we parse + commit into the draft and the
 *  mirror re-syncs from the formatted draft value. Per-tier rather
 *  than per-week so swapping selection wipes them cleanly via the
 *  watcher below. */
const verseInput150 = ref('')
const verseInput300 = ref('')
const verseInputError = ref<string | null>(null)

/** Re-seed the mirrors whenever the selected week changes (including
 *  null → some-week). Without this the prior week's text would linger
 *  in the inputs after the user clicks a new row. */
watch(
  () => (selection.value?.kind === 'week' ? selection.value.weekIdx : -1),
  () => {
    const w = selectedWeek.value
    verseInputError.value = null
    verseInput150.value = formatVerseList(w?.verses?.club150)
    verseInput300.value = formatVerseList(w?.verses?.club300)
  },
  { immediate: true },
)

function commitVerseInput(tier: 'club150' | 'club300') {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const raw = tier === 'club150' ? verseInput150.value : verseInput300.value
  const parsed = parseVerseList(raw)
  if (parsed === null) {
    verseInputError.value
      = 'Verses must be positive whole numbers separated by commas or spaces.'
    return
  }
  verseInputError.value = null
  const idx = selection.value.weekIdx
  const week = draft.value.weeks[idx]
  if (!week) return
  const nextVerses = { ...(week.verses ?? {}), [tier]: parsed }
  draft.value.weeks[idx] = { ...week, verses: nextVerses }
  // Re-format from canonical (sorted, deduped is the parser's
  // responsibility) so the user sees the normalized value after blur.
  if (tier === 'club150') verseInput150.value = formatVerseList(parsed)
  else verseInput300.value = formatVerseList(parsed)
}

function updatePassageField<K extends 'book' | 'chapter' | 'startVerse' | 'endVerse'>(
  key: K,
  value: K extends 'book' ? string : number,
) {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const idx = selection.value.weekIdx
  const week = draft.value.weeks[idx]
  if (!week) return
  // Coerce review week toggle: starting a passage edit on a review week
  // implicitly de-reviews it via the dedicated toggle, not by side
  // effect — guard so the editor doesn't silently un-mark.
  if (week.passage === null) return
  draft.value.weeks[idx] = {
    ...week,
    passage: { ...week.passage, [key]: value },
  }
}

function toggleReviewWeek() {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const idx = selection.value.weekIdx
  const week = draft.value.weeks[idx]
  if (!week) return
  if (week.isReview) {
    // De-reviewing: rehydrate empty passage + verses so the editor has
    // something to bind. The user fills in the actual passage details.
    draft.value.weeks[idx] = {
      ...week,
      isReview: false,
      passage: { book: '', chapter: 0, startVerse: 0, endVerse: 0 },
      verses: { club150: [], club300: [] },
    }
  } else {
    draft.value.weeks[idx] = { ...week, isReview: true, passage: null, verses: null }
  }
  // Re-seed the verse mirrors after the structural change.
  const next = draft.value.weeks[idx]
  verseInput150.value = formatVerseList(next.verses?.club150)
  verseInput300.value = formatVerseList(next.verses?.club300)
}

function addWeekAfterLast() {
  if (draft.value === null) return
  const last = draft.value.weeks[draft.value.weeks.length - 1]
  // Default the new week's date to one week after the last existing
  // week, falling back to today when the schedule has none yet. The
  // user can pick a passage from the edit form once selected.
  const newDate = last ? shiftDate(last.date, 7) : new Date().toISOString().slice(0, 10)
  const blank: ScheduleWeek = {
    date: newDate,
    passage: { book: '', chapter: 0, startVerse: 0, endVerse: 0 },
    verses: { club150: [], club300: [] },
    isReview: false,
  }
  draft.value = addWeekAt(draft.value, draft.value.weeks.length, blank)
  selectWeek(draft.value.weeks.length - 1)
}

function removeSelectedWeek() {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const idx = selection.value.weekIdx
  draft.value = removeWeekAt(draft.value, idx)
  // Move selection to the previous week if there is one; otherwise drop.
  if (draft.value.weeks.length === 0) {
    selection.value = null
  } else {
    const nextIdx = Math.min(idx, draft.value.weeks.length - 1)
    selectWeek(nextIdx)
  }
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
    const s = await api.getSchedule(materialId.value)
    saved.value = s
    draft.value = s === null ? null : cloneSchedule(s)
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

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload)
  await refresh()
  // After the table has rendered, bring the current week into view —
  // a 30+ week table otherwise leaves the user at the top, mid-season.
  // No-op when the season hasn't started or has already ended.
  await nextTick()
  document
    .querySelector('.week-row.is-current')
    ?.scrollIntoView({ block: 'center', behavior: 'instant' })
})

// onBeforeRouteLeave is component-scoped and clears itself; the
// beforeunload listener needs an explicit removal.
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
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
              {{ display.season }} · meets {{
                fullDayName(display.meetingDayOfWeek)
              }}s ·
              {{ display.weeks.length }} weeks ·
              {{ display.meets.length }} meets
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

      <div v-if="mode === 'edit'" class="day-picker">
        <label>
          <span>Meets on</span>
          <select
            :value="display.meetingDayOfWeek"
            @change="onMeetingDayChange(($event.target as HTMLSelectElement).value as DayOfWeek)"
          >
            <option v-for="d in DAYS_OF_WEEK" :key="d" :value="d">
              {{ fullDayName(d) }}s
            </option>
          </select>
        </label>
        <p class="day-picker-hint">
          Changing the meeting day shifts every practice week by the same
          delta. Meet weekends stay on their own dates.
        </p>
      </div>

      <section class="editor-body" :class="{ 'is-editing': mode === 'edit' }">
        <div class="table-pane">
          <table class="schedule-table" aria-label="Season schedule">
            <thead>
              <tr>
                <th scope="col" class="col-date">Date</th>
                <th scope="col" class="col-passage">Passage</th>
                <th scope="col" class="col-verses">Club 150</th>
                <th scope="col" class="col-verses">Club 300</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in rows" :key="row.key">
                <tr v-if="row.kind === 'month'" class="month-row">
                  <th colspan="4" scope="rowgroup" class="month-label">
                    {{ row.label }}
                  </th>
                </tr>
                <tr
                  v-else-if="row.kind === 'week'"
                  class="week-row"
                  :class="{
                    'is-current': row.isCurrent,
                    'is-selected': isWeekRowSelected(row.weekIdx),
                    'is-review': row.week.isReview,
                  }"
                  :aria-current="row.isCurrent ? 'date' : undefined"
                  @click="mode === 'edit' ? selectWeek(row.weekIdx) : null"
                >
                  <td class="cell-date">{{ row.ordinal }}</td>
                  <td class="cell-passage">{{ formatPassage(row.week.passage) }}</td>
                  <td class="cell-verses">
                    <span v-if="row.week.verses?.club150?.length">
                      {{ formatVerseList(row.week.verses.club150) }}
                    </span>
                  </td>
                  <td class="cell-verses">
                    <span v-if="row.week.verses?.club300?.length">
                      {{ formatVerseList(row.week.verses.club300) }}
                    </span>
                  </td>
                </tr>
                <tr
                  v-else-if="row.kind === 'meet'"
                  class="meet-row"
                  :class="{ 'is-selected': isMeetRowSelected(row.meet.id) }"
                  @click="mode === 'edit' ? selectMeet(row.meet.id) : null"
                >
                  <td colspan="4" class="meet-cell">
                    <span class="meet-dates">{{ row.dateRange }}</span>
                    <span class="meet-name">{{ row.meet.name }}</span>
                    <span v-if="row.meet.location" class="meet-location">
                      | {{ row.meet.location }}
                    </span>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <div v-if="mode === 'edit'" class="add-row">
            <button type="button" class="add-week" @click="addWeekAfterLast">
              + Add a week
            </button>
            <button type="button" class="add-week" @click="addMeetAfterLast">
              + Add a meet
            </button>
          </div>
        </div>

        <aside
          v-if="mode === 'edit'"
          class="detail"
          aria-label="Selected item"
        >
          <p v-if="selection === null" class="placeholder">
            Pick a row from the schedule to edit it.
          </p>

          <!-- Week form. Date is derived from meetingDayOfWeek + week
               ordering and isn't directly editable per the Phase 3
               design (no per-week overrides). -->
          <form
            v-else-if="selectedWeek"
            class="week-form"
            @submit.prevent
          >
            <p class="detail-date">{{ formatTimelineDate(selectedWeek.date) }}</p>

            <label class="toggle">
              <input
                type="checkbox"
                :checked="selectedWeek.isReview"
                @change="toggleReviewWeek"
              />
              <span>Review week (no new verses introduced)</span>
            </label>

            <template v-if="!selectedWeek.isReview && selectedWeek.passage">
              <fieldset class="passage">
                <legend>Passage</legend>
                <label class="field passage-book">
                  <span>Book</span>
                  <input
                    type="text"
                    :value="selectedWeek.passage.book"
                    @input="updatePassageField('book', ($event.target as HTMLInputElement).value)"
                  />
                </label>
                <label class="field passage-chapter">
                  <span>Chapter</span>
                  <input
                    type="number"
                    min="1"
                    :value="selectedWeek.passage.chapter || ''"
                    @input="updatePassageField('chapter', Number(($event.target as HTMLInputElement).value) || 0)"
                  />
                </label>
                <label class="field passage-start">
                  <span>Start verse</span>
                  <input
                    type="number"
                    min="1"
                    :value="selectedWeek.passage.startVerse || ''"
                    @input="updatePassageField('startVerse', Number(($event.target as HTMLInputElement).value) || 0)"
                  />
                </label>
                <label class="field passage-end">
                  <span>End verse</span>
                  <input
                    type="number"
                    min="1"
                    :value="selectedWeek.passage.endVerse || ''"
                    @input="updatePassageField('endVerse', Number(($event.target as HTMLInputElement).value) || 0)"
                  />
                </label>
              </fieldset>

              <fieldset class="verses">
                <legend>Verse numbers</legend>
                <label class="field">
                  <span>Club 150</span>
                  <input
                    v-model="verseInput150"
                    type="text"
                    inputmode="numeric"
                    placeholder="e.g. 5, 10, 17, 18"
                    @blur="commitVerseInput('club150')"
                  />
                </label>
                <label class="field">
                  <span>Club 300</span>
                  <input
                    v-model="verseInput300"
                    type="text"
                    inputmode="numeric"
                    placeholder="e.g. 1, 2, 4, 8"
                    @blur="commitVerseInput('club300')"
                  />
                </label>
                <p v-if="verseInputError" class="field-error" role="alert">
                  {{ verseInputError }}
                </p>
                <p class="field-hint">
                  Comma- or space-separated verse numbers. Saved to the draft on blur.
                </p>
              </fieldset>
            </template>

            <button
              type="button"
              class="danger"
              @click="removeSelectedWeek"
            >
              Remove this week
            </button>
          </form>

          <form
            v-else-if="selectedMeet"
            class="meet-form"
            @submit.prevent
          >
            <fieldset class="meet-fields">
              <legend>Meet</legend>
              <label class="field">
                <span>Name</span>
                <input
                  type="text"
                  :value="selectedMeet.name"
                  @input="updateMeetField('name', ($event.target as HTMLInputElement).value)"
                />
              </label>
              <label class="field">
                <span>Start date</span>
                <input
                  type="date"
                  :value="selectedMeet.startDate"
                  @input="updateMeetField('startDate', ($event.target as HTMLInputElement).value)"
                />
              </label>
              <label class="field">
                <span>End date</span>
                <input
                  type="date"
                  :value="selectedMeet.endDate"
                  @input="updateMeetField('endDate', ($event.target as HTMLInputElement).value)"
                />
              </label>
              <label class="field meet-location">
                <span>Location (optional, may be "TBD")</span>
                <input
                  type="text"
                  :value="selectedMeet.location"
                  @input="updateMeetField('location', ($event.target as HTMLInputElement).value)"
                />
              </label>
              <p v-if="meetEndDateError" class="field-error" role="alert">
                {{ meetEndDateError }}
              </p>
            </fieldset>
            <button type="button" class="danger" @click="removeSelectedMeet">
              Remove this meet
            </button>
          </form>
        </aside>
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
  </div>
</template>

<style scoped>
/* View mode keeps the existing 960px cap (same as the rest of the app
 * for prose readability). Edit mode needs more horizontal room — the
 * form pane and the 4-column table would otherwise squeeze the verse
 * cells into 2-line wraps. The `:has(.is-editing)` selector promotes
 * the wrapper to the wider cap only while editing. */
.schedule-editor {
  width: 100%;
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.schedule-editor:has(.editor-body.is-editing) {
  max-width: 1240px;
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

/* View mode: single-column flow (the table IS the detail).
 * Edit mode: two-column grid with the form pane on the right.
 * The `.is-editing` class on `.editor-body` flips between them. */
.editor-body {
  display: block;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.25rem 1.5rem;
}

/* `auto` for the table cell pairs with `.schedule-table`'s
 * `width: max-content` so the cell shrinks to the table's
 * natural width — without this, the cell would still be 1fr
 * and the table would sit at the left of a cell with hundreds
 * of pixels of trailing whitespace before the form pane. */
.editor-body.is-editing {
  display: grid;
  grid-template-columns: auto minmax(18rem, 22rem);
  gap: 1.5rem;
  align-items: start;
}

@media (max-width: 920px) {
  .editor-body.is-editing {
    grid-template-columns: 1fr;
  }
}

.table-pane {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

/* Shrink the table to its widest row rather than stretching across
 * the grid cell — `width: 100%` makes verse cells (the only
 * width: auto columns) absorb hundreds of trailing pixels when
 * verse lists are short, which looks aimless next to the printable
 * PDF's tight columns. `max-content` lets each column size to its
 * widest cell while `max-width: 100%` still prevents overflow on
 * narrow viewports. */
.schedule-table {
  width: max-content;
  max-width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
  font-variant-numeric: tabular-nums;
}

.schedule-table thead th {
  text-align: left;
  padding: 0 0.5rem 0.6rem;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-muted);
  border-bottom: 1px solid var(--color-border);
}

.col-date {
  width: 4rem;
}

.col-passage {
  width: 13rem;
}

.col-verses {
  width: auto;
}

.month-row .month-label {
  padding: 1.2rem 0.5rem 0.35rem;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-text);
  text-align: left;
  border-bottom: none;
}

.week-row > td {
  padding: 0.35rem 0.5rem;
  vertical-align: top;
  border-top: 1px solid transparent;
  border-bottom: 1px solid transparent;
}

.cell-date {
  color: var(--color-muted);
  white-space: nowrap;
}

.cell-date::before {
  content: '– ';
  color: var(--color-muted);
}

.cell-passage {
  color: var(--color-text);
  white-space: nowrap;
}

.cell-verses {
  color: var(--color-text);
  word-spacing: 0.05em;
}

.week-row.is-review .cell-passage {
  color: var(--color-muted);
  font-style: italic;
}

/* "You are here." Left-edge accent + bolder title. The current-week
 * marker is the first thing the user looks for; this needs to be
 * visible without scanning. */
.week-row.is-current > td {
  background: var(--color-accent-soft);
}

.week-row.is-current .cell-date {
  color: var(--color-accent);
  font-weight: 600;
}

.week-row.is-current .cell-date::before {
  content: '▸ ';
  color: var(--color-accent);
  font-weight: 700;
}

.week-row.is-current .cell-passage {
  font-weight: 600;
  color: var(--color-text);
}

.editor-body.is-editing .week-row {
  cursor: pointer;
}

.editor-body.is-editing .week-row:hover > td {
  background: var(--color-bg);
}

.editor-body.is-editing .week-row.is-selected > td {
  background: var(--color-accent-soft);
}

.meet-row .meet-cell {
  padding: 0.6rem 0.5rem;
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--color-text);
}

.meet-dates {
  color: var(--color-muted);
  margin-right: 0.5rem;
  font-weight: 500;
}

.meet-name {
  color: var(--color-text);
}

.meet-location {
  color: var(--color-muted);
  font-weight: 400;
  margin-left: 0.3rem;
}

.editor-body.is-editing .meet-row {
  cursor: pointer;
}

.editor-body.is-editing .meet-row:hover .meet-cell,
.editor-body.is-editing .meet-row.is-selected .meet-cell {
  background: var(--color-accent-soft);
}

.add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
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

.detail {
  padding: 0.5rem 0.5rem 1rem;
}

.detail-date {
  margin: 0 0 1rem;
  color: var(--color-muted);
  font-size: 0.85rem;
}

.placeholder {
  margin: 0;
  padding: 2rem 1rem;
  color: var(--color-muted);
  font-style: italic;
  text-align: center;
}

.week-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
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

.field input:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
  border-color: var(--color-accent);
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

.meet-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.meet-location {
  grid-column: 1 / -1;
}
</style>
