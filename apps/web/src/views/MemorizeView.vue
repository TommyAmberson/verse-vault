<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { type CardRender, api } from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'

// Per-year cap built at mount from /years. Each enrolled year with new
// cards contributes min(newCardCount, lessonBatchSize) verses; the
// session walks the queue front-to-back. The future mem-schedule work
// will replace this aggregate-quota model with something smarter.
interface YearQuota {
  materialId: string
  remaining: number
}

// Per-verse drill phase: a quick "read the verse" intro, then cycle
// the verse's cards (Again re-queues, Good removes) until every card
// has been passed once, then a closing "read it again" before
// graduating. None of these grades flow to FSRS — memorize stays
// pure-intro per the planning notes.
type Phase = 'reading_start' | 'drilling' | 'reading_end'

const queue = ref<YearQuota[]>([])
const verseId = ref<number | null>(null)
const drillQueue = ref<number[]>([])
const card = ref<CardRender | null>(null)
const anchorCard = ref<CardRender | null>(null)
const phase = ref<Phase>('reading_start')
const revealed = ref(false)
const graduatedCount = ref(0)
const totalTarget = ref(0)
const done = ref(false)
const empty = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
const submitting = ref(false)

const currentMaterialId = computed(() => queue.value[0]?.materialId ?? null)
const totalDrillCards = ref(0)
const remainingDrillCards = computed(() => drillQueue.value.length)

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
  anchorCard.value = null
  try {
    const res = await api.getNextMemorizeProgression(currentMaterialId.value)
    const firstCardId = res.cardIds[0]
    if (res.verseId === null || firstCardId === undefined) {
      // This year ran out before its quota — drop it and move on.
      queue.value.shift()
      await loadVerse()
      return
    }
    verseId.value = res.verseId
    drillQueue.value = [...res.cardIds]
    totalDrillCards.value = res.cardIds.length
    phase.value = 'reading_start'
    revealed.value = true
    // Anchor render = first card, used to display the verse during the
    // reading_start/reading_end phases.
    anchorCard.value = await api.getCardRender(currentMaterialId.value, firstCardId)
    card.value = anchorCard.value
  } catch (err) {
    error.value = formatError(err)
  } finally {
    loading.value = false
  }
}

async function loadCurrentDrillCard() {
  const cardId = drillQueue.value[0]
  if (cardId === undefined || !currentMaterialId.value) return
  loading.value = true
  try {
    card.value = await api.getCardRender(currentMaterialId.value, cardId)
    revealed.value = false
  } catch (err) {
    error.value = formatError(err)
  } finally {
    loading.value = false
  }
}

async function startDrilling() {
  phase.value = 'drilling'
  await loadCurrentDrillCard()
}

function reveal() {
  revealed.value = true
}

async function gradeAgain() {
  if (submitting.value) return
  // Push the current card to the back of the queue so it cycles again.
  const id = drillQueue.value.shift()
  if (id !== undefined) drillQueue.value.push(id)
  await loadCurrentDrillCard()
}

async function gradeGood() {
  if (submitting.value) return
  drillQueue.value.shift()
  if (drillQueue.value.length === 0) {
    phase.value = 'reading_end'
    revealed.value = true
    card.value = anchorCard.value
    return
  }
  await loadCurrentDrillCard()
}

async function graduate() {
  const active = queue.value[0]
  if (verseId.value === null || !active || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await api.graduateVerse(active.materialId, verseId.value)
    graduatedCount.value += 1
    active.remaining -= 1
    if (active.remaining <= 0) queue.value.shift()
    if (queue.value.length === 0) {
      verseId.value = null
      card.value = null
      anchorCard.value = null
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
        <template v-if="phase === 'reading_start'">
          Verse {{ graduatedCount + 1 }} of {{ totalTarget }} · Read it through
        </template>
        <template v-else-if="phase === 'drilling'">
          Verse {{ graduatedCount + 1 }} of {{ totalTarget }} ·
          {{ totalDrillCards - remainingDrillCards + 1 }} of {{ totalDrillCards }} cards
        </template>
        <template v-else>
          Verse {{ graduatedCount + 1 }} of {{ totalTarget }} · Read it once more
        </template>
      </div>
      <CardPrompt :card="card" :revealed="revealed" />
      <div class="actions">
        <button
          v-if="phase === 'reading_start'"
          class="primary"
          :disabled="submitting"
          @click="startDrilling"
        >
          Start drilling
        </button>
        <button
          v-else-if="phase === 'drilling' && !revealed"
          class="primary"
          :disabled="submitting"
          @click="reveal"
        >
          Reveal answer
        </button>
        <div v-else-if="phase === 'drilling' && revealed" class="grades">
          <button class="grade grade-again" :disabled="submitting" @click="gradeAgain">
            Again
          </button>
          <button class="grade grade-good" :disabled="submitting" @click="gradeGood">
            Good
          </button>
        </div>
        <button
          v-else-if="phase === 'reading_end'"
          class="primary"
          :disabled="submitting"
          @click="graduate"
        >
          Graduate verse
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

.primary {
  padding: 0.75rem 1.5rem;
  background: var(--color-accent);
  color: var(--color-on-accent);
  border: none;
  border-radius: 6px;
  font-weight: 500;
  font-size: 1rem;
}

.primary:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.grades {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
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

.grade-good {
  background: var(--color-grade-good-bg);
  color: var(--color-grade-good);
}

.grade:hover:not(:disabled) {
  border-color: currentColor;
}
</style>
