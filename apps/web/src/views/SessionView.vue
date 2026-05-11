<script setup lang="ts">
import { onMounted, ref } from 'vue'

import {
  ApiError,
  type CardRender,
  type Grade,
  MATERIAL_ID,
  api,
} from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'

const card = ref<CardRender | null>(null)
const revealed = ref(false)
const done = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
const submitting = ref(false)

async function loadNext() {
  loading.value = true
  error.value = null
  try {
    const { cardId } = await api.getNextCard(MATERIAL_ID)
    if (cardId === null) {
      card.value = null
      done.value = true
    } else {
      card.value = await api.getCardRender(MATERIAL_ID, cardId)
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
  if (!card.value || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    const res = await api.submitReview(MATERIAL_ID, card.value.cardId, grade)
    if (res.nextCardId === null) {
      card.value = null
      done.value = true
    } else {
      card.value = await api.getCardRender(MATERIAL_ID, res.nextCardId)
      revealed.value = false
    }
  } catch (err) {
    error.value = formatError(err)
  } finally {
    submitting.value = false
  }
}

async function ensureEnrolled() {
  try {
    await api.enroll(MATERIAL_ID)
  } catch (err) {
    // 409 = already enrolled, expected on subsequent loads.
    if (err instanceof ApiError && err.status === 409) return
    throw err
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

onMounted(async () => {
  try {
    await ensureEnrolled()
    await loadNext()
  } catch (err) {
    error.value = formatError(err)
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
  max-width: 640px;
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

/* Outer card surface: white-on-page with a neutral border, holding
   the meta label, the verse-coloured flashcard box (rendered by
   CardPrompt), and the grade buttons. */
.card {
  background: var(--color-bg-card);
  border: 1.5px solid var(--color-text);
  border-radius: 10px;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.reveal {
  padding: 0.75rem 1.5rem;
  background: var(--color-accent);
  color: white;
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
