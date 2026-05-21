<script setup lang="ts">
import { onMounted, ref } from 'vue'

import {
  type CardRender,
  type Grade,
  api,
} from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'
import { useEngine } from '@/composables/useEngine'

// useEngine is bound synchronously at setup so its lifecycle hooks
// register correctly; init(materialId) defers the actual engine load
// until we know which year to review.
const engine = useEngine()

const materialId = ref<string | null>(null)
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
  const target = res.years.find((y) => y.enrolled && y.settings.reviewScope !== 'off')
  if (target) {
    materialId.value = target.materialId
    return true
  }
  return false
}

async function loadNext() {
  if (!engine.ready.value) return
  loading.value = true
  error.value = null
  try {
    const cardId = engine.nextReviewCard()
    if (cardId === null) {
      card.value = null
      done.value = true
    } else {
      card.value = await engine.getCardRender(cardId)
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
  if (!engine.ready.value || !card.value || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await engine.submitGrade(card.value.cardId, grade)
    // Engine pick + render happen locally now; the network sync
    // catches up in the background. No spinner between cards.
    const nextId = engine.nextReviewCard()
    if (nextId === null) {
      card.value = null
      done.value = true
    } else {
      card.value = await engine.getCardRender(nextId)
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
    await engine.init(materialId.value)
    await loadNext()
  } catch (err) {
    error.value = formatError(err)
  } finally {
    loading.value = false
  }
})
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
