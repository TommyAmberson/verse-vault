<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

import {
  type CardRender,
  type Grade,
  api,
} from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'
import StaleMergeModal from '@/components/StaleMergeModal.vue'
import { useEngine } from '@/composables/useEngine'
import type { WireMaterialConfig } from '@/lib/engine/types'

// useEngine is bound synchronously at setup so its lifecycle hooks
// register correctly; init(materialId) defers the actual engine load
// until we know which year to review.
const engine = useEngine()

const materialId = ref<string | null>(null)
const materialConfig = shallowRef<WireMaterialConfig | null>(null)
const card = ref<CardRender | null>(null)
const revealed = ref(false)
const done = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
const submitting = ref(false)

async function resolveMaterial() {
  // Pick the first enrolled year with review turned on. The local
  // engine's next_review_card returns null when nothing's due, which
  // the view handles as the "session complete" state below.
  const res = await api.getYears()
  // Pick the first enrolled year with any review club enabled. Reading
  // per-club `review.{club}.enabled` matches what the engine actually
  // uses to gate reviews — the legacy `settings.reviewScope` is a
  // derived mirror kept for backward compat but is authoritative only
  // for pre-Phase-1 rows.
  const target = res.years.find(
    (y) => y.enrolled && Object.values(y.perClub.review).some((c) => c.enabled),
  )
  if (target) {
    materialId.value = target.materialId
    materialConfig.value = target.perClub
    return true
  }
  return false
}

async function loadNext() {
  if (!engine.ready.value || !materialId.value) return
  loading.value = true
  error.value = null
  try {
    const cardId = engine.nextReviewCard(materialId.value)
    if (cardId === null) {
      card.value = null
      done.value = true
    } else {
      card.value = await engine.getCardRender(materialId.value, cardId)
      revealed.value = false
      done.value = false
    }
  } catch (err) {
    error.value = formatError(err)
  } finally {
    loading.value = false
  }
}

async function submit(grade: Grade) {
  if (!engine.ready.value || !card.value || submitting.value || !materialId.value) return
  submitting.value = true
  error.value = null
  try {
    await engine.submitGrade(materialId.value, card.value.cardId, grade)
    // Engine pick + render happen locally now; the network sync
    // catches up in the background. No spinner between cards.
    const nextId = engine.nextReviewCard(materialId.value)
    if (nextId === null) {
      card.value = null
      done.value = true
    } else {
      card.value = await engine.getCardRender(materialId.value, nextId)
      revealed.value = false
    }
  } catch (err) {
    error.value = formatError(err)
  } finally {
    submitting.value = false
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

onMounted(async () => {
  try {
    loading.value = true
    const found = await resolveMaterial()
    if (!found || !materialId.value) {
      done.value = true
      return
    }
    // Pull the schedule alongside settings so the engine ctor receives
    // it on the first call. /review doesn't actually use Phase 1 of the
    // memorize fill, but the engine is shared with /memorize via the
    // session cache — a later /memorize visit gets the schedule too.
    const schedule = await api.getSchedule(materialId.value)
    await engine.init(materialId.value, materialConfig.value ?? undefined, schedule ?? '')
    await loadNext()
  } catch (err) {
    error.value = formatError(err)
  } finally {
    loading.value = false
  }
})

/** Keyboard shortcuts: Enter to reveal the back, 1-4 to grade once
 *  revealed. The capture-phase listener is intentional — it catches
 *  Enter inside the type-to-recite textarea before the textarea would
 *  insert a newline. The grade keys are unambiguous (the back has no
 *  inputs) so they ride the regular bubble. The stale-merge modal
 *  takes precedence: while it's open, the shortcuts no-op so the user
 *  can use Enter/digits in any modal inputs without grading silently. */
function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
  if (!card.value || engine.staleSummary.value) return

  if (e.key === 'Enter') {
    if (!revealed.value && !submitting.value) {
      e.preventDefault()
      revealed.value = true
    }
    return
  }

  if (!revealed.value) return
  const grade = ({ '1': 1, '2': 2, '3': 3, '4': 4 } as const)[e.key]
  if (grade !== undefined) {
    e.preventDefault()
    void submit(grade)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <div class="session">
    <div v-if="error" class="banner banner-error">{{ error }}</div>

    <div v-if="loading && !card" class="status">Loading…</div>

    <div v-else-if="done" class="done">
      <h2>Session complete</h2>
      <p>Nothing else is due right now.</p>
      <RouterLink to="/stats" class="link-button">View stats →</RouterLink>
    </div>

    <div v-else-if="card" class="card">
      <CardPrompt :card="card" :revealed="revealed" />

      <div class="actions">
        <button
          v-if="!revealed"
          class="reveal"
          :disabled="submitting"
          @click="revealed = true"
        >
          Reveal answer
        </button>
        <div v-else class="grades">
          <button class="grade grade-again" :disabled="submitting" @click="submit(1)">
            Again
          </button>
          <button class="grade grade-hard" :disabled="submitting" @click="submit(2)">
            Hard
          </button>
          <button class="grade grade-good" :disabled="submitting" @click="submit(3)">
            Good
          </button>
          <button class="grade grade-easy" :disabled="submitting" @click="submit(4)">
            Easy
          </button>
        </div>
      </div>
    </div>

    <StaleMergeModal
      v-if="engine.staleSummary.value"
      :summary="engine.staleSummary.value"
      :busy="engine.syncing.value"
      @confirm="engine.confirmMerge"
      @discard="engine.discardStale"
      @cancel="engine.cancelStale"
    />
  </div>
</template>

<style scoped>
.session {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.banner {
  padding: 0.75rem 1rem;
  border-radius: 6px;
  font-size: 0.95rem;
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

.done {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 2rem;
  text-align: center;
}

.done h2 {
  margin-bottom: 0.5rem;
}

.link-button {
  display: inline-block;
  margin-top: 1rem;
  color: var(--color-accent);
  font-weight: 500;
}

/* Layout wrapper only — no surface or border. Stretches to fill the
   session column so the grade buttons can pin themselves to the
   bottom while the meta label + flashcard box sit at the top. */
.card {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  flex: 1;
}

/* Push the grade buttons (and the Reveal button before they appear)
   to the bottom of the .card column. Empty space goes between the
   flashcard box and the buttons. */
.actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: auto;
}

.reveal {
  padding: 0.75rem 1.5rem;
  background: var(--color-accent);
  color: var(--color-on-accent);
  border: none;
  border-radius: 6px;
  font-weight: 500;
  font-size: 1rem;
}

.reveal:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.grades {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.5rem;
}

.grade {
  padding: 0.75rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 6px;
  font-weight: 500;
  font-size: 0.95rem;
}

.grade-again {
  background: var(--color-grade-again-bg);
  color: var(--color-grade-again);
}

.grade-hard {
  background: var(--color-grade-hard-bg);
  color: var(--color-grade-hard);
}

.grade-good {
  background: var(--color-grade-good-bg);
  color: var(--color-grade-good);
}

.grade-easy {
  background: var(--color-grade-easy-bg);
  color: var(--color-grade-easy);
}

.grade:hover:not(:disabled) {
  border-color: currentColor;
}
</style>
