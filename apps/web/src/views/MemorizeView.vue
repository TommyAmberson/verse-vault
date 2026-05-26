<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { type CardRender, type MemorizeSessionVerse, api } from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'
import StaleMergeModal from '@/components/StaleMergeModal.vue'
import { useEngine } from '@/composables/useEngine'
import { buildMaterialConfig } from '@/lib/engine/types'

// MemorizeView spans every enrolled year with new cards. useEngine
// supports multiple materials in one session — each year's verses get
// loaded via init(materialId), then the per-call materialId on the
// action methods routes work to the right engine.
const engine = useEngine()

// One session walks three phases: read every verse first, drill every
// card (shuffled by verse), then walk the verses again and graduate
// each one. None of this is FSRS-graded — memorize stays pure-intro.
type Phase = 'reading_start' | 'drilling' | 'reading_end' | 'done'

interface SessionVerse extends MemorizeSessionVerse {
  materialId: string
  /** Anchor render used during reading_start and reading_end: the
   *  verse's Recitation when available, falling back to the first
   *  drill card. Recitation avoids the phrase-0 highlight a PhraseFill
   *  would impose. */
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
 *  while each verse's cards stay in builder order. */
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
  // Each enrolled year contributes up to its lessonBatchSize verses.
  // Reading walkthroughs stay in collection order so opening + closing
  // reads expose verses in the same shape.
  const yearsRes = await api.getYears()
  const eligibleYears = yearsRes.years.filter(
    (y) => y.enrolled && y.settings.newScope !== 'off' && y.newCardCount > 0,
  )
  // Boot the engine for every eligible year in parallel, then compute
  // each year's session payload locally. Settings pass through so the
  // engine respects per-year scope toggles (e.g. chapter_list_scope).
  await Promise.all(
    eligibleYears.map((y) => engine.init(y.materialId, buildMaterialConfig(y.settings))),
  )
  const sessions: { materialId: string; verses: MemorizeSessionVerse[] }[] = eligibleYears.map(
    (y) => ({
      materialId: y.materialId,
      verses: engine.memorizeSession(y.materialId, y.settings.lessonBatchSize).verses,
    }),
  )
  const collected: SessionVerse[] = []
  for (const { materialId, verses: ys } of sessions) {
    for (const v of ys) {
      if (v.cardIds.length === 0) continue
      collected.push({
        materialId,
        verseId: v.verseId,
        cardIds: v.cardIds,
        recitationCardId: v.recitationCardId,
        anchor: null,
        graduated: false,
      })
    }
  }
  verses.value = collected

  // Pre-fetch anchor renders so the reading walkthroughs don't pause
  // for a round trip per verse. Prefer Recitation to avoid the phrase-0
  // highlight a PhraseFill render would impose. Renders come from the
  // engine's IDB-cached + lazy network path.
  await Promise.all(
    collected.map(async (v) => {
      const anchorId = v.recitationCardId ?? v.cardIds[0]
      if (anchorId === undefined || anchorId === null) return
      v.anchor = await engine.getCardRender(v.materialId, anchorId)
    }),
  )

  // Verses interleave; cards within a verse keep builder order on the
  // initial pass so the user doesn't see card 2 before card 1.
  const byVerse: DrillEntry[][] = collected.map((v) =>
    v.cardIds.map((cardId) => ({ materialId: v.materialId, verseId: v.verseId, cardId })),
  )
  const drill = interleaveByVerse(byVerse)
  drillQueue.value = drill
  totalDrillCards.value = drill.length
}

async function startDrilling() {
  // If every verse was already-memorized'd in the read-through, there's
  // nothing to drill and nothing to re-confirm — skip straight to done.
  if (drillQueue.value.length === 0) {
    phase.value = 'done'
    return
  }
  phase.value = 'drilling'
  drillRevealed.value = false
  await loadDrillCard()
}

async function loadDrillCard() {
  const entry = currentDrill.value
  if (!entry) return
  loading.value = true
  try {
    drillCard.value = await engine.getCardRender(entry.materialId, entry.cardId)
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
    enterReadingEnd()
    return
  }
  await loadDrillCard()
}

/** Position the reading_end cursor at the first verse that still needs
 *  a closing read — already-memorized verses got their graduation up
 *  front in reading_start and don't need re-confirmation. If everything
 *  was front-loaded, jump straight to done. */
function enterReadingEnd() {
  const first = verses.value.findIndex((v) => !v.graduated)
  if (first === -1) {
    phase.value = 'done'
    return
  }
  phase.value = 'reading_end'
  readingIndex.value = first
}

function advanceReadingStart() {
  if (onLastReading.value) {
    void startDrilling()
    return
  }
  readingIndex.value += 1
}

/** Reading-start opt-out: the user already knows this verse, so
 *  graduate it immediately, drop its cards from the drill queue, and
 *  advance. Equivalent to running through drilling + reading_end's
 *  Graduate without actually doing them. */
async function alreadyMemorizedCurrentReadingStart() {
  const v = currentReadingVerse.value
  if (!v || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await engine.submitGraduation(v.materialId, v.verseId)
    v.graduated = true
    drillQueue.value = drillQueue.value.filter(
      (e) => !(e.materialId === v.materialId && e.verseId === v.verseId),
    )
    totalDrillCards.value = drillQueue.value.length
    advanceReadingStart()
  } catch (err) {
    error.value = formatError(err)
  } finally {
    submitting.value = false
  }
}

async function graduateCurrentReadingEnd() {
  const v = currentReadingVerse.value
  if (!v || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await engine.submitGraduation(v.materialId, v.verseId)
    v.graduated = true
    advanceReadingEnd()
  } catch (err) {
    error.value = formatError(err)
  } finally {
    submitting.value = false
  }
}

function skipCurrentReadingEnd() {
  advanceReadingEnd()
}

/** Step to the next non-graduated verse, or done if none remain. Skips
 *  over verses already-memorized in reading_start so the user isn't
 *  asked twice. */
function advanceReadingEnd() {
  for (let i = readingIndex.value + 1; i < verses.value.length; i++) {
    if (!verses.value[i]!.graduated) {
      readingIndex.value = i
      return
    }
  }
  phase.value = 'done'
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

/** Keyboard shortcuts mirroring the on-screen buttons:
 *  - Enter advances whichever primary button is showing (Next/Start,
 *    Reveal, Graduate). Capture phase so the type-to-recite textarea
 *    flips to the back instead of inserting a newline.
 *  - 1/2 = Again / Not yet (left); 3/4 = Good / Graduate (right).
 *    Mirrors the Review keypad's left/right split — Memorize's two
 *    buttons just claim two digits each so muscle memory carries
 *    over and no key sits inert. */
function onKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
  if (engine.staleSummary.value || submitting.value) return

  if (e.key === 'Enter') {
    if (phase.value === 'reading_start' && currentReadingVerse.value?.anchor) {
      e.preventDefault()
      advanceReadingStart()
    } else if (phase.value === 'drilling' && drillCard.value && !drillRevealed.value) {
      e.preventDefault()
      revealDrill()
    } else if (phase.value === 'reading_end' && currentReadingVerse.value?.anchor) {
      e.preventDefault()
      void graduateCurrentReadingEnd()
    }
    return
  }

  if (phase.value === 'drilling' && drillRevealed.value) {
    if (e.key === '1' || e.key === '2') {
      e.preventDefault()
      void gradeAgain()
    } else if (e.key === '3' || e.key === '4') {
      e.preventDefault()
      void gradeGood()
    }
  } else if (phase.value === 'reading_end') {
    if (e.key === '1' || e.key === '2') {
      e.preventDefault()
      skipCurrentReadingEnd()
    } else if (e.key === '3' || e.key === '4') {
      e.preventDefault()
      void graduateCurrentReadingEnd()
    }
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
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
        <div class="read-actions">
          <button
            class="secondary"
            :disabled="submitting"
            @click="alreadyMemorizedCurrentReadingStart"
          >
            Already memorized
          </button>
          <button class="primary" :disabled="submitting" @click="advanceReadingStart">
            {{ onLastReading ? 'Start drilling' : 'Next verse' }}
          </button>
        </div>
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

/* Side-by-side action row for reading_start: a muted "Already
   memorized" escape hatch sits next to the primary "Next verse /
   Start drilling" action so users can skip drilling verses they
   already know without it being the dominant click target. */
.read-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.5rem;
}

.secondary {
  padding: 0.75rem 1rem;
  background: transparent;
  color: var(--color-muted);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-weight: 500;
  font-size: 1rem;
}

.secondary:hover:not(:disabled) {
  color: var(--color-text);
  border-color: var(--color-text);
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
