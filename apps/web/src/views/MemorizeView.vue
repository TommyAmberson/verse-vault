<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { type CardRender, type MemorizeSessionVerse, api } from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'

// One session walks three phases: read every verse first, drill every
// card (shuffled by verse), then walk the verses again and graduate
// each one. None of this is FSRS-graded — memorize stays pure-intro.
type Phase = 'reading_start' | 'drilling' | 'reading_end' | 'done'

interface SessionVerse extends MemorizeSessionVerse {
  materialId: string
  /** Anchor render — the first card's data, used to show the verse
   *  text during reading_start and reading_end. */
  anchor: CardRender | null
  graduated: boolean
}

interface DrillEntry {
  materialId: string
  verseId: number
  cardId: number
}

const verses = ref<SessionVerse[]>([])
const phase = ref<Phase>('reading_start')
const readingIndex = ref(0)
const drillQueue = ref<DrillEntry[]>([])
const totalDrillCards = ref(0)
const drillCard = ref<CardRender | null>(null)
const drillRevealed = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
const submitting = ref(false)

const empty = computed(() => phase.value !== 'done' && verses.value.length === 0)
const totalVerses = computed(() => verses.value.length)
const remainingDrillCards = computed(() => drillQueue.value.length)

const currentReadingVerse = computed<SessionVerse | null>(() =>
  verses.value[readingIndex.value] ?? null,
)
const onLastReading = computed(() => readingIndex.value === verses.value.length - 1)
const currentDrill = computed<DrillEntry | null>(() => drillQueue.value[0] ?? null)

/** Interleave per-verse card lists so verses appear in random order
 *  but each verse's cards stay in their builder order. Equivalent to:
 *  at each step, pick a random non-empty verse and pop its next card. */
function interleaveByVerse(byVerse: DrillEntry[][]): DrillEntry[] {
  const pools: DrillEntry[][] = byVerse.map((c) => [...c]).filter((c) => c.length > 0)
  const out: DrillEntry[] = []
  while (pools.length > 0) {
    const i = Math.floor(Math.random() * pools.length)
    const next = pools[i]!.shift()!
    out.push(next)
    if (pools[i]!.length === 0) pools.splice(i, 1)
  }
  return out
}

async function buildSession() {
  // Collect every enrolled year with `New` cards. Each contributes up to
  // its own lessonBatchSize verses. Random verse order is applied to the
  // drill queue; reading walkthroughs stay in collection order so the
  // user reads the same shape twice.
  const yearsRes = await api.getYears()
  const collected: SessionVerse[] = []
  for (const y of yearsRes.years) {
    if (!y.enrolled || y.settings.newScope === 'off' || y.newCardCount === 0) continue
    const session = await api.getMemorizeSession(y.materialId, y.settings.lessonBatchSize)
    for (const v of session.verses) {
      if (v.cardIds.length === 0) continue
      collected.push({
        materialId: y.materialId,
        verseId: v.verseId,
        cardIds: v.cardIds,
        anchor: null,
        graduated: false,
      })
    }
  }
  verses.value = collected

  // Pre-fetch each verse's anchor render so reading_start has the
  // verse text ready without per-step round trips.
  await Promise.all(
    collected.map(async (v) => {
      const first = v.cardIds[0]
      if (first === undefined) return
      v.anchor = await api.getCardRender(v.materialId, first)
    }),
  )

  // Build the drill queue. Per-verse card lists stay in builder order;
  // interleaving picks a random non-empty verse for each step so the
  // user moves between verses constantly without ever seeing a verse's
  // card 2 before card 1 on the initial pass.
  const byVerse: DrillEntry[][] = collected.map((v) =>
    v.cardIds.map((cardId) => ({ materialId: v.materialId, verseId: v.verseId, cardId })),
  )
  const drill = interleaveByVerse(byVerse)
  drillQueue.value = drill
  totalDrillCards.value = drill.length
}

async function startDrilling() {
  phase.value = 'drilling'
  drillRevealed.value = false
  await loadDrillCard()
}

async function loadDrillCard() {
  const entry = currentDrill.value
  if (!entry) return
  loading.value = true
  try {
    drillCard.value = await api.getCardRender(entry.materialId, entry.cardId)
    drillRevealed.value = false
  } catch (err) {
    error.value = formatError(err)
  } finally {
    loading.value = false
  }
}

function revealDrill() {
  drillRevealed.value = true
}

async function gradeAgain() {
  if (submitting.value) return
  const entry = drillQueue.value.shift()
  if (entry) drillQueue.value.push(entry)
  await loadDrillCard()
}

async function gradeGood() {
  if (submitting.value) return
  drillQueue.value.shift()
  if (drillQueue.value.length === 0) {
    phase.value = 'reading_end'
    readingIndex.value = 0
    return
  }
  await loadDrillCard()
}

function advanceReadingStart() {
  if (onLastReading.value) {
    void startDrilling()
    return
  }
  readingIndex.value += 1
}

async function graduateCurrentReadingEnd() {
  const v = currentReadingVerse.value
  if (!v || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await api.graduateVerse(v.materialId, v.verseId)
    v.graduated = true
    if (onLastReading.value) {
      phase.value = 'done'
      return
    }
    readingIndex.value += 1
  } catch (err) {
    error.value = formatError(err)
  } finally {
    submitting.value = false
  }
}

function skipCurrentReadingEnd() {
  if (onLastReading.value) {
    phase.value = 'done'
    return
  }
  readingIndex.value += 1
}

const graduatedCount = computed(() => verses.value.filter((v) => v.graduated).length)

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

onMounted(async () => {
  try {
    loading.value = true
    await buildSession()
    if (verses.value.length === 0) return
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

    <div v-if="loading && verses.length === 0" class="status">Loading…</div>

    <div v-else-if="phase === 'done'" class="done">
      <h2>Memorized {{ graduatedCount }} verse{{ graduatedCount === 1 ? '' : 's' }}</h2>
      <p>Start another session when you're ready, or move on to review.</p>
      <RouterLink to="/review" class="link-button">Review now →</RouterLink>
    </div>

    <div v-else-if="empty" class="done">
      <h2>Nothing to memorize</h2>
      <p>
        Activate a club in <RouterLink to="/material">/material</RouterLink> to introduce new
        verses.
      </p>
    </div>

    <!-- Reading walkthrough (used at both ends of the session). -->
    <div
      v-else-if="phase === 'reading_start' && currentReadingVerse?.anchor"
      class="card"
    >
      <div class="meta">
        Read it through · Verse {{ readingIndex + 1 }} of {{ totalVerses }}
      </div>
      <CardPrompt :card="currentReadingVerse.anchor" :revealed="true" />
      <div class="actions">
        <button class="primary" :disabled="submitting" @click="advanceReadingStart">
          {{ onLastReading ? 'Start drilling' : 'Next verse' }}
        </button>
      </div>
    </div>

    <div v-else-if="phase === 'drilling' && drillCard" class="card">
      <div class="meta">
        Drilling · {{ totalDrillCards - remainingDrillCards + 1 }} of
        {{ totalDrillCards }} cards
      </div>
      <CardPrompt :card="drillCard" :revealed="drillRevealed" />
      <div class="actions">
        <button
          v-if="!drillRevealed"
          class="primary"
          :disabled="submitting"
          @click="revealDrill"
        >
          Reveal answer
        </button>
        <div v-else class="grades">
          <button class="grade grade-again" :disabled="submitting" @click="gradeAgain">
            Again
          </button>
          <button class="grade grade-good" :disabled="submitting" @click="gradeGood">
            Good
          </button>
        </div>
      </div>
    </div>

    <div
      v-else-if="phase === 'reading_end' && currentReadingVerse?.anchor"
      class="card"
    >
      <div class="meta">
        Read it once more · Verse {{ readingIndex + 1 }} of {{ totalVerses }}
      </div>
      <CardPrompt :card="currentReadingVerse.anchor" :revealed="true" />
      <div class="actions">
        <div class="grades">
          <button
            class="grade grade-again"
            :disabled="submitting"
            @click="skipCurrentReadingEnd"
          >
            Not yet
          </button>
          <button
            class="grade grade-good"
            :disabled="submitting"
            @click="graduateCurrentReadingEnd"
          >
            Graduate
          </button>
        </div>
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
