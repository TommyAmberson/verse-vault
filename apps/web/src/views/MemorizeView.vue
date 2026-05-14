<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { type CardRender, type MemorizeStep, api } from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'

// Per-year cap built at mount from /years. Each enrolled year with new
// cards contributes min(newCardCount, lessonBatchSize) verses; the
// session walks the queue front-to-back. The future mem-schedule work
// will replace this aggregate-quota model with something smarter.
interface YearQuota {
  materialId: string
  remaining: number
}

const queue = ref<YearQuota[]>([])
const verseId = ref<number | null>(null)
const progression = ref<MemorizeStep[]>([])
const stepIndex = ref(0)
const card = ref<CardRender | null>(null)
const graduatedCount = ref(0)
const totalTarget = ref(0)
const done = ref(false)
const empty = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
const submitting = ref(false)

const currentStep = computed(() => progression.value[stepIndex.value] ?? null)
const totalSteps = computed(() => progression.value.length)
const isLastStep = computed(
  () => totalSteps.value > 0 && stepIndex.value === totalSteps.value - 1,
)
const currentMaterialId = computed(() => queue.value[0]?.materialId ?? null)

async function buildQueue(): Promise<boolean> {
  const res = await api.getYears()
  const quotas: YearQuota[] = []
  for (const y of res.years) {
    if (!y.enrolled || y.settings.newScope === 'off' || y.newCardCount === 0) continue
    quotas.push({
      materialId: y.materialId,
      remaining: Math.min(y.newCardCount, y.settings.lessonBatchSize),
    })
  }
  queue.value = quotas
  totalTarget.value = quotas.reduce((sum, q) => sum + q.remaining, 0)
  return quotas.length > 0
}

async function loadVerse() {
  if (!currentMaterialId.value) {
    empty.value = !done.value
    return
  }
  loading.value = true
  error.value = null
  card.value = null
  try {
    const res = await api.getNextMemorizeProgression(currentMaterialId.value)
    if (res.verseId === null || res.progression.length === 0) {
      // This year ran out before its quota — drop it and move on.
      queue.value.shift()
      await loadVerse()
      return
    }
    verseId.value = res.verseId
    progression.value = res.progression
    stepIndex.value = 0
    await loadStepCard()
  } catch (err) {
    error.value = formatError(err)
  } finally {
    loading.value = false
  }
}

async function loadStepCard() {
  const step = currentStep.value
  if (!step || !currentMaterialId.value) return
  loading.value = true
  try {
    card.value = await api.getCardRender(currentMaterialId.value, step.cardId)
  } catch (err) {
    error.value = formatError(err)
  } finally {
    loading.value = false
  }
}

async function nextStep() {
  if (submitting.value) return
  if (!isLastStep.value) {
    stepIndex.value += 1
    await loadStepCard()
    return
  }
  // Last step for this verse: graduate, decrement the current year's
  // quota, and move on. Pop the year when it hits zero.
  const active = queue.value[0]
  if (verseId.value === null || !active) return
  submitting.value = true
  error.value = null
  try {
    await api.graduateVerse(active.materialId, verseId.value)
    graduatedCount.value += 1
    active.remaining -= 1
    if (active.remaining <= 0) queue.value.shift()
    if (queue.value.length === 0) {
      verseId.value = null
      progression.value = []
      card.value = null
      done.value = true
      return
    }
    await loadVerse()
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

const stepLabel = computed(() => {
  const step = currentStep.value
  if (!step) return ''
  if (step.kind === 'PhraseFill') return `Phrase ${step.position + 1}`
  return 'Recitation'
})

const buttonLabel = computed(() => (isLastStep.value ? 'Got it — graduate' : 'Next'))

onMounted(async () => {
  try {
    loading.value = true
    const found = await buildQueue()
    if (!found) {
      empty.value = true
      return
    }
    await loadVerse()
  } catch (err) {
    error.value = formatError(err)
  } finally {
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
      <p>
        Activate a club in <RouterLink to="/material">/material</RouterLink> to introduce new
        verses.
      </p>
    </div>

    <div v-else-if="card" class="card">
      <div class="meta">
        Verse {{ graduatedCount + 1 }} of {{ totalTarget }} ·
        Step {{ stepIndex + 1 }} of {{ totalSteps }} · {{ stepLabel }}
      </div>
      <CardPrompt :card="card" :revealed="true" />
      <div class="actions">
        <button class="advance" :disabled="submitting" @click="nextStep">
          {{ buttonLabel }}
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

.advance {
  padding: 0.75rem 1.5rem;
  background: var(--color-accent);
  color: var(--color-on-accent);
  border: none;
  border-radius: 6px;
  font-weight: 500;
  font-size: 1rem;
}

.advance:hover:not(:disabled) {
  background: var(--color-accent-hover);
}
</style>
