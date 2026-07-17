<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import type { CardRender, Grade } from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'
import StaleMergeModal from '@/components/StaleMergeModal.vue'
import { useEngine } from '@/composables/useEngine'

// useEngine is bound synchronously at setup so its lifecycle hooks
// register correctly; init(materialId) defers the actual engine load
// until we know which years to review.
const engine = useEngine()

// Every enrolled year with any review club enabled and a booted
// engine, in /years order. The session drains them in order: one
// year's queue empties before the next year's first card surfaces
// (a single-material pick here was the tail of #107 symptom C — see
// CHANGELOG 0.9.3).
const materialIds = ref<string[]>([])
// The year the on-screen card belongs to — grades must route to the
// engine that produced the card.
const currentMaterialId = ref<string | null>(null)
const card = ref<CardRender | null>(null)
const revealed = ref(false)
const done = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
const submitting = ref(false)

/** First due card across every booted year, in `materialIds` order.
 *  Rescans from the top on every call — "drained" isn't monotonic
 *  (an earlier year's card can come out of sibling cooldown or lapse
 *  mid-session), so earlier years reclaim priority when they re-fill. */
function nextDueCard(): { materialId: string; cardId: number } | null {
  for (const id of materialIds.value) {
    const cardId = engine.nextReviewCard(id)
    if (cardId !== null) return { materialId: id, cardId }
  }
  return null
}

async function advance() {
  const next = nextDueCard()
  if (next === null) {
    currentMaterialId.value = null
    card.value = null
    done.value = true
    return
  }
  // Render before assigning: `card` and `currentMaterialId` must swap
  // together. Setting the id first would, on a failed render, leave
  // the previous card on screen tagged with the next card's material —
  // and the next grade would route to the wrong engine.
  const render = await engine.getCardRender(next.materialId, next.cardId)
  currentMaterialId.value = next.materialId
  card.value = render
  revealed.value = false
  done.value = false
}

async function submit(grade: Grade) {
  if (!engine.ready.value || !card.value || submitting.value || !currentMaterialId.value) return
  submitting.value = true
  error.value = null
  try {
    await engine.submitGrade(currentMaterialId.value, card.value.cardId, grade)
    // Engine pick + render happen locally now; the network sync
    // catches up in the background. No spinner between cards.
    await advance()
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
    const targets = await engine.initEligibleYears('review')
    if (targets.length === 0) {
      done.value = true
      return
    }
    // Serve only years whose engine actually booted. `init` swallows
    // its own failures, so a failed year must be excluded here — and
    // must surface as an error, not fold into "Session complete"
    // (which would recreate the badge-vs-session mismatch this view
    // exists to avoid).
    materialIds.value = targets.map((y) => y.materialId).filter((id) => engine.isActive(id))
    if (materialIds.value.length === 0) {
      error.value = 'Failed to load the review engine — try reloading the page.'
      return
    }
    if (materialIds.value.length < targets.length) {
      error.value = 'Some years failed to load; reviewing the rest.'
    }
    await advance()
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
