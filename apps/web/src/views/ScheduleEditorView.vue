<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'

import { api } from '@/api'
import {
  type Schedule,
  cloneSchedule,
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

      <!-- Body panes land in commits 4 — 7. The shell + draft state +
           nav-away guard are intentionally in place first so the
           interactive surface can be built incrementally without
           re-architecting the host every commit. -->
      <section class="editor-body">
        <div class="placeholder">
          <p>
            Schedule editor panes (timeline, week detail, meets, meeting-day
            picker) land in subsequent commits.
          </p>
          <p class="meta">
            Mode: <strong>{{ mode }}</strong>
            · Dirty: <strong>{{ isDirty ? 'yes' : 'no' }}</strong>
          </p>
        </div>
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
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.25rem 1.5rem;
  min-height: 12rem;
}

.placeholder {
  color: var(--color-muted);
  font-size: 0.9rem;
  text-align: center;
}

.placeholder .meta {
  margin-top: 1rem;
  font-family: monospace;
  font-size: 0.8rem;
}
</style>
