<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'

import { api } from '@/api'
import {
  type Schedule,
  type ScheduleMeet,
  type ScheduleWeek,
  addMeet,
  addWeekAt,
  cloneSchedule,
  formatPassage,
  formatVerseList,
  parseVerseList,
  removeMeet,
  removeWeekAt,
  shiftDate,
  slugifyMeetId,
  updateMeet,
  verseCountsForWeek,
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

interface TimelineItem {
  kind: 'week' | 'meet'
  /** Primary sort key — week.date or meet.startDate. */
  sortKey: string
  /** Original index into display.weeks; only meaningful when kind === 'week'. */
  weekIdx: number
  week?: ScheduleWeek
  meet?: ScheduleMeet
}

/** Single chronological list of weeks + meets for the left pane. Meets
 *  sort after a week on the same date (the practice happens first,
 *  the meet weekend lands during/after). Within meets on the same
 *  startDate, the array order wins. */
const timeline = computed<TimelineItem[]>(() => {
  const s = display.value
  if (s === null) return []
  const items: TimelineItem[] = []
  s.weeks.forEach((week, weekIdx) => {
    items.push({ kind: 'week', sortKey: week.date, weekIdx, week })
  })
  s.meets.forEach((meet) => {
    // weekIdx is unused for meet items; -1 makes that explicit.
    items.push({ kind: 'meet', sortKey: meet.startDate, weekIdx: -1, meet })
  })
  return items.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey.localeCompare(b.sortKey)
    // Same date: weeks before meets.
    if (a.kind !== b.kind) return a.kind === 'week' ? -1 : 1
    return 0
  })
})

function selectWeek(weekIdx: number) {
  selection.value = { kind: 'week', weekIdx }
}

function selectMeet(meetId: string) {
  selection.value = { kind: 'meet', meetId }
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

function updateWeekField<K extends keyof ScheduleWeek>(key: K, value: ScheduleWeek[K]) {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const idx = selection.value.weekIdx
  const week = draft.value.weeks[idx]
  if (!week) return
  draft.value.weeks[idx] = { ...week, [key]: value }
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

/** Dirty iff the user has actually edited the draft. JSON.stringify
 *  is sound because both objects originate from the same construction
 *  path (server JSON → structuredClone), so key order matches. */
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
              {{ display.season }} · meets {{ display.meetingDayOfWeek
              }}s ·
              {{ display.weeks.length }} weeks ·
              {{ display.meets.length }} meets
            </p>
          </div>
        </div>

        <div class="mode-controls">
          <template v-if="mode === 'view'">
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

      <section class="editor-body">
        <nav class="timeline-pane" aria-label="Schedule timeline">
          <ol class="timeline">
            <li
              v-for="(item, i) in timeline"
              :key="`${item.kind}-${item.kind === 'week' ? item.weekIdx : item.meet?.id}-${i}`"
              :class="[
                `timeline-item timeline-${item.kind}`,
                {
                  'is-selected':
                    (item.kind === 'week'
                      && selection?.kind === 'week'
                      && selection.weekIdx === item.weekIdx)
                    || (item.kind === 'meet'
                      && selection?.kind === 'meet'
                      && selection.meetId === item.meet?.id),
                },
              ]"
            >
              <button
                v-if="item.kind === 'week' && item.week"
                type="button"
                class="timeline-button"
                @click="selectWeek(item.weekIdx)"
              >
                <span class="row-date">{{ formatTimelineDate(item.week.date) }}</span>
                <span class="row-body">
                  <span class="row-title">{{ formatPassage(item.week.passage) }}</span>
                  <span v-if="!item.week.isReview" class="row-meta">
                    {{ verseCountsForWeek(item.week).club150 }} / {{ verseCountsForWeek(item.week).club300 }}
                  </span>
                  <span v-else class="row-meta">Review week</span>
                </span>
              </button>
              <button
                v-else-if="item.kind === 'meet' && item.meet"
                type="button"
                class="timeline-button meet"
                @click="selectMeet(item.meet.id)"
              >
                <span class="row-date">{{ formatMeetDateRange(item.meet) }}</span>
                <span class="row-body">
                  <span class="row-title">⛺ {{ item.meet.name }}</span>
                  <span v-if="item.meet.location" class="row-meta">{{ item.meet.location }}</span>
                </span>
              </button>
            </li>
          </ol>
          <div v-if="mode === 'edit'" class="add-row">
            <button type="button" class="add-week" @click="addWeekAfterLast">
              + Add a week
            </button>
            <button type="button" class="add-week" @click="addMeetAfterLast">
              + Add a meet
            </button>
          </div>
        </nav>

        <section class="detail" aria-label="Selected item">
          <p v-if="selection === null" class="placeholder">
            Pick a week or meet from the timeline.
          </p>

          <!-- View-mode week display: same read-only shape regardless of
               whether the user is editing the schedule overall. -->
          <div
            v-else-if="selectedWeek && mode === 'view'"
            class="detail-week"
          >
            <h3>{{ formatPassage(selectedWeek.passage) }}</h3>
            <p class="detail-date">{{ formatTimelineDate(selectedWeek.date) }}</p>
            <dl v-if="!selectedWeek.isReview">
              <dt>Club 150</dt>
              <dd>{{ (selectedWeek.verses?.club150 ?? []).join(', ') || '—' }}</dd>
              <dt>Club 300</dt>
              <dd>{{ (selectedWeek.verses?.club300 ?? []).join(', ') || '—' }}</dd>
            </dl>
            <p v-else class="detail-review">Review week — no new verses.</p>
          </div>

          <!-- Edit-mode week form. Date is derived from the schedule's
               meetingDayOfWeek + week ordering and isn't editable per
               the Phase 3 design (no per-week overrides). -->
          <form
            v-else-if="selectedWeek && mode === 'edit'"
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

          <!-- View-mode meet display. -->
          <div
            v-else-if="selectedMeet && mode === 'view'"
            class="detail-meet"
          >
            <h3>⛺ {{ selectedMeet.name }}</h3>
            <p class="detail-date">{{ formatMeetDateRange(selectedMeet) }}</p>
            <p v-if="selectedMeet.location" class="detail-location">{{ selectedMeet.location }}</p>
          </div>

          <!-- Edit-mode meet form. -->
          <form
            v-else-if="selectedMeet && mode === 'edit'"
            class="meet-form"
            @submit.prevent
          >
            <fieldset>
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
        </section>
      </section>
    </template>
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

.editor-body {
  display: grid;
  grid-template-columns: minmax(0, 18rem) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1rem;
  min-height: 18rem;
}

@media (max-width: 720px) {
  .editor-body {
    grid-template-columns: 1fr;
  }
}

.timeline-pane {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 60vh;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
}

.add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
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

.timeline-item {
  border-bottom: 1px solid var(--color-border);
}

.timeline-item:last-child {
  border-bottom: none;
}

.timeline-item.is-selected {
  background: var(--color-accent-soft);
}

.timeline-button {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(7rem, auto) 1fr;
  gap: 0.7rem;
  align-items: center;
  background: none;
  border: none;
  padding: 0.5rem 0.75rem;
  font-family: inherit;
  font-size: 0.85rem;
  text-align: left;
  color: var(--color-text);
  cursor: pointer;
}

.timeline-button:hover {
  background: var(--color-accent-soft);
}

.timeline-button.meet {
  background: var(--color-bg-card);
  font-style: italic;
}

.timeline-button.meet:hover {
  background: var(--color-accent-soft);
}

.row-date {
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.row-body {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.row-title {
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-meta {
  color: var(--color-muted);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}

.detail {
  padding: 0.5rem 0.5rem 1rem;
}

.detail h3 {
  margin: 0 0 0.25rem;
  font-size: 1.05rem;
  font-weight: 600;
}

.detail-date {
  margin: 0 0 1rem;
  color: var(--color-muted);
  font-size: 0.85rem;
}

.detail-location {
  margin: 0;
  color: var(--color-muted);
  font-size: 0.85rem;
}

.detail-review {
  margin: 0;
  color: var(--color-muted);
  font-style: italic;
}

.detail dl {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.4rem 1rem;
  font-size: 0.9rem;
}

.detail dt {
  color: var(--color-muted);
  font-weight: 500;
}

.detail dd {
  margin: 0;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
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
fieldset.verses {
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

.meet-form fieldset {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem 1rem;
}

.meet-form fieldset legend {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-muted);
  padding: 0 0.3rem;
}

.meet-location {
  grid-column: 1 / -1;
}
</style>
