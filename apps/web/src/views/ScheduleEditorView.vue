<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'

import { api } from '@/api'
import {
  type Schedule,
  type ScheduleMeet,
  type ScheduleWeek,
  cloneSchedule,
  formatPassage,
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
        <nav class="timeline" aria-label="Schedule timeline">
          <ol>
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
        </nav>

        <!-- Detail pane lands in commits 5 (week) and 6 (meet). For now
             this is a read-only display of whatever the user selected so
             the timeline is useful even before the editors arrive. -->
        <section class="detail" aria-label="Selected item">
          <p v-if="selection === null" class="placeholder">
            Pick a week or meet from the timeline.
          </p>
          <div v-else-if="selectedWeek" class="detail-week">
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
          <div v-else-if="selectedMeet" class="detail-meet">
            <h3>⛺ {{ selectedMeet.name }}</h3>
            <p class="detail-date">{{ formatMeetDateRange(selectedMeet) }}</p>
            <p v-if="selectedMeet.location" class="detail-location">{{ selectedMeet.location }}</p>
          </div>
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

.timeline {
  max-height: 60vh;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
}

.timeline ol {
  list-style: none;
  margin: 0;
  padding: 0;
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
</style>
