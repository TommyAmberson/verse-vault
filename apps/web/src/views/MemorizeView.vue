<script setup lang="ts">
import { onMounted, ref } from 'vue'

import {
  ApiError,
  type CardRender,
  MATERIAL_ID,
  api,
} from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'

// TODO: pull from year settings; hardcoded to the default lesson batch
// size while the picker plumbing isn't wired into this view yet.
const BATCH_SIZE = 3

const card = ref<CardRender | null>(null)
const graduatedCount = ref(0)
const done = ref(false)
const empty = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
const submitting = ref(false)

async function loadNext() {
  loading.value = true
  error.value = null
  try {
    const { cardId } = await api.getNextMemorizeCard(MATERIAL_ID)
    if (cardId === null) {
      card.value = null
      empty.value = true
    } else {
      card.value = await api.getCardRender(MATERIAL_ID, cardId)
    }
  } catch (err) {
    error.value = formatError(err)
  } finally {
    loading.value = false
  }
}

async function graduate() {
  if (!card.value || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await api.graduateVerse(MATERIAL_ID, card.value.verseId)
    graduatedCount.value += 1
    if (graduatedCount.value >= BATCH_SIZE) {
      card.value = null
      done.value = true
      return
    }
    await loadNext()
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
  <div class="memorize">
    <div v-if="error" class="banner banner-error">{{ error }}</div>

    <div v-if="loading && !card" class="status">Loading…</div>

    <div v-else-if="done" class="done">
      <h2>Memorized {{ graduatedCount }} verse{{ graduatedCount === 1 ? '' : 's' }}</h2>
      <p>Start another batch when you're ready, or move on to review.</p>
      <RouterLink to="/review" class="link-button">Review now →</RouterLink>
    </div>

    <div v-else-if="empty" class="done">
      <h2>Nothing to memorize</h2>
      <p>Activate a club in <RouterLink to="/material">/material</RouterLink> to introduce new verses.</p>
    </div>

    <div v-else-if="card" class="card">
      <CardPrompt :card="card" :revealed="true" />
      <div class="meta">
        Verse {{ graduatedCount + 1 }} of {{ BATCH_SIZE }} this session
      </div>
      <div class="actions">
        <button class="graduate" :disabled="submitting" @click="graduate">
          Got it — next verse
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memorize {
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

.card {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  flex: 1;
}

.meta {
  text-align: center;
  color: var(--color-muted);
  font-size: 0.85rem;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: auto;
}

.graduate {
  padding: 0.75rem 1.5rem;
  background: var(--color-accent);
  color: var(--color-on-accent);
  border: none;
  border-radius: 6px;
  font-weight: 500;
  font-size: 1rem;
}

.graduate:hover:not(:disabled) {
  background: var(--color-accent-hover);
}
</style>
