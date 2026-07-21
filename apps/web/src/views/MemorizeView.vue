<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type { CardRender, MemorizeSessionVerse } from '@/api'
import CardPrompt from '@/components/CardPrompt.vue'
import StaleMergeModal from '@/components/StaleMergeModal.vue'
import { useEngine } from '@/composables/useEngine'

// MemorizeView spans every enrolled year with new cards. useEngine
// supports multiple materials in one session — each year's verses get
// loaded via init(materialId), then the per-call materialId on the
// action methods routes work to the right engine.
const engine = useEngine()

// One session walks three phases: read every item first, drill every
// card in random order, then walk the items again and graduate each
// one. None of this is FSRS-graded — memorize stays pure-intro.
type Phase = 'reading_start' | 'drilling' | 'reading_end' | 'done'

interface VerseItem {
  kind: 'verse'
  materialId: string
  verseId: number
  cardIds: number[]
  /** Subset of `cardIds` that need an explicit graduate_card on
   *  step-3 graduation; graduate_verse handles the rest. */
  conditionalCardIds: number[]
  /** Card id used to fetch the reading-walkthrough anchor render
   *  (Recitation when emitted, else the first drill card). */
  anchorCardId: number | null
  anchor: CardRender | null
  graduated: boolean
}

interface StandaloneItem {
  kind: 'standalone'
  materialId: string
  cardId: number
  slot: 'hp' | 'ccl' | 'orphan'
  anchor: CardRender | null
  graduated: boolean
}

type ReadingItem = VerseItem | StandaloneItem

interface DrillEntry {
  materialId: string
  cardId: number
  /** Index into `items` so a step-1 "Already memorized" on an item
   *  can drop every drill entry sourced from that item in one filter. */
  itemIdx: number
}

const items = ref<ReadingItem[]>([])
const phase = ref<Phase>('reading_start')
const readingIndex = ref(0)
const drillQueue = ref<DrillEntry[]>([])
const totalDrillCards = ref(0)
const drillCard = ref<CardRender | null>(null)
const drillRevealed = ref(false)
const error = ref<string | null>(null)
const loading = ref(false)
const submitting = ref(false)

const empty = computed(() => phase.value !== 'done' && items.value.length === 0)
const totalItems = computed(() => items.value.length)
const remainingDrillCards = computed(() => drillQueue.value.length)

const currentReadingItem = computed<ReadingItem | null>(() =>
  items.value[readingIndex.value] ?? null,
)
const onLastReading = computed(() => readingIndex.value === items.value.length - 1)
const currentDrill = computed<DrillEntry | null>(() => drillQueue.value[0] ?? null)
const graduatedCount = computed(
  () => items.value.filter((i) => i.kind === 'verse' && i.graduated).length,
)

/** Fisher–Yates shuffle, non-mutating. */
function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i]!, out[j]!] = [out[j]!, out[i]!]
  }
  return out
}

async function buildSession() {
  // Each enrolled year contributes up to its lessonBatchSize verses.
  // Reading walkthroughs stay in collection order so opening + closing
  // reads expose items in the same shape. Boot every eligible year's
  // engine (enrolled + an enabled memorize tier + new cards to serve);
  // each year's session payload is computed locally below.
  const eligibleYears = await engine.initEligibleYears(
    'memorize',
    (y) => y.newCardCount > 0,
  )
  // Serve only years whose engine actually booted. `init` swallows its
  // own failures, so a year that failed to load isn't in `active` and
  // calling `memorizeSession` on it would throw "no session" and abort
  // the whole multi-year session. Mirrors ReviewView's isActive filter.
  const sessions: {
    materialId: string
    verses: MemorizeSessionVerse[]
    orphans: number[]
  }[] = eligibleYears
    .filter((y) => engine.isActive(y.materialId))
    .map((y) => {
      const s = engine.memorizeSession(y.materialId, y.perClub.lessonBatchSize)
      return { materialId: y.materialId, verses: s.verses, orphans: s.orphans }
    })
  // Flatten the session into reading items: each verse anchors its
  // own item with HP / CCL items appended after it; top-level orphan
  // cards (the verse-less standalone overflow) follow at the end of
  // the year's chunk. The drill queue is a flat shuffle across every
  // card the user will encounter.
  const collected: ReadingItem[] = []
  const drillPool: DrillEntry[] = []
  for (const { materialId, verses: ys, orphans } of sessions) {
    for (const v of ys) {
      if (v.cardIds.length === 0 && v.hpCardId === undefined && v.cclCardId === undefined) {
        continue
      }
      const verseIdx = collected.length
      collected.push({
        kind: 'verse',
        materialId,
        verseId: v.verseId,
        cardIds: v.cardIds,
        conditionalCardIds: v.conditionalCardIds ?? [],
        anchorCardId: v.recitationCardId ?? v.cardIds[0] ?? null,
        anchor: null,
        graduated: false,
      })
      for (const cardId of v.cardIds) {
        drillPool.push({ materialId, cardId, itemIdx: verseIdx })
      }
      if (v.hpCardId !== undefined) {
        const idx = collected.length
        collected.push({
          kind: 'standalone',
          materialId,
          cardId: v.hpCardId,
          slot: 'hp',
          anchor: null,
          graduated: false,
        })
        drillPool.push({ materialId, cardId: v.hpCardId, itemIdx: idx })
      }
      if (v.cclCardId !== undefined) {
        const idx = collected.length
        collected.push({
          kind: 'standalone',
          materialId,
          cardId: v.cclCardId,
          slot: 'ccl',
          anchor: null,
          graduated: false,
        })
        drillPool.push({ materialId, cardId: v.cclCardId, itemIdx: idx })
      }
    }
    for (const orphanId of orphans) {
      const idx = collected.length
      collected.push({
        kind: 'standalone',
        materialId,
        cardId: orphanId,
        slot: 'orphan',
        anchor: null,
        graduated: false,
      })
      drillPool.push({ materialId, cardId: orphanId, itemIdx: idx })
    }
  }
  items.value = collected

  // Pre-fetch every reading anchor in parallel via the engine's
  // IDB-cached + lazy network path.
  await Promise.all(
    collected.map(async (item) => {
      const anchorId = item.kind === 'verse' ? item.anchorCardId : item.cardId
      if (anchorId === null) return
      item.anchor = await engine.getCardRender(item.materialId, anchorId)
    }),
  )

  const drill = shuffle(drillPool)
  drillQueue.value = drill
  totalDrillCards.value = drill.length
}

async function startDrilling() {
  // If every item was already-memorized'd in the read-through, there's
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
  // Set `submitting` BEFORE the queue mutation so a key-repeat or
  // double-click on the Again button (or '1' key) can't fire twice
  // before `loadDrillCard` finishes — the grade handlers were
  // previously gated on `submitting` but never set it, so rapid
  // input rotated the drill queue twice and silently skipped a card.
  submitting.value = true
  try {
    const entry = drillQueue.value.shift()
    if (entry) drillQueue.value.push(entry)
    await loadDrillCard()
  } finally {
    submitting.value = false
  }
}

async function gradeGood() {
  if (submitting.value) return
  submitting.value = true
  try {
    drillQueue.value.shift()
    if (drillQueue.value.length === 0) {
      enterReadingEnd()
      return
    }
    await loadDrillCard()
  } finally {
    submitting.value = false
  }
}

/** Graduate one reading item and drop its drill entries. */
async function graduateItem(item: ReadingItem, itemIdx: number): Promise<void> {
  if (item.kind === 'verse') {
    await Promise.all([
      engine.submitGraduation(item.materialId, item.verseId),
      ...item.conditionalCardIds.map((id) => engine.submitCardGraduation(item.materialId, id)),
    ])
  } else {
    await engine.submitCardGraduation(item.materialId, item.cardId)
  }
  item.graduated = true
  drillQueue.value = drillQueue.value.filter((e) => e.itemIdx !== itemIdx)
  totalDrillCards.value = drillQueue.value.length
}

/** Position the reading_end cursor at the first item that still
 *  needs a closing read — already-memorized items got their
 *  graduation up front in reading_start and don't need
 *  re-confirmation. If everything was front-loaded, jump straight
 *  to done. */
function enterReadingEnd() {
  const first = items.value.findIndex((i) => !i.graduated)
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

/** Reading-start opt-out: the user already knows this item, so
 *  graduate it immediately, drop its drill entries, and advance. */
async function alreadyMemorizedCurrentReadingStart() {
  const item = currentReadingItem.value
  if (!item || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await graduateItem(item, readingIndex.value)
    advanceReadingStart()
  } catch (err) {
    error.value = formatError(err)
  } finally {
    submitting.value = false
  }
}

async function graduateCurrentReadingEnd() {
  const item = currentReadingItem.value
  if (!item || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await graduateItem(item, readingIndex.value)
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

/** Step to the next non-graduated item, or done if none remain.
 *  Skips items already-memorized in reading_start so the user
 *  isn't asked twice. */
function advanceReadingEnd() {
  for (let i = readingIndex.value + 1; i < items.value.length; i++) {
    if (!items.value[i]!.graduated) {
      readingIndex.value = i
      return
    }
  }
  phase.value = 'done'
}

function readingLabel(item: ReadingItem): string {
  if (item.kind === 'verse') return 'Verse'
  if (item.slot === 'hp') return 'Heading passage'
  if (item.slot === 'ccl') return 'Chapter list'
  return 'Extra card'
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

onMounted(async () => {
  try {
    loading.value = true
    await buildSession()
    if (items.value.length === 0) return
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
    if (phase.value === 'reading_start' && currentReadingItem.value?.anchor) {
      e.preventDefault()
      advanceReadingStart()
    } else if (phase.value === 'drilling' && drillCard.value && !drillRevealed.value) {
      e.preventDefault()
      revealDrill()
    } else if (phase.value === 'reading_end' && currentReadingItem.value?.anchor) {
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

    <div v-if="loading && items.length === 0" class="status">Loading…</div>

    <div v-else-if="phase === 'done'" class="done">
      <h2>Memorized {{ graduatedCount }} verse{{ graduatedCount === 1 ? '' : 's' }}</h2>
      <p>Start another session when you're ready, or move on to review.</p>
      <RouterLink to="/review" class="link-button">Review now →</RouterLink>
    </div>

    <div v-else-if="empty" class="done">
      <h2>Nothing to memorize</h2>
      <p>
        Activate a club in <RouterLink to="/settings">/settings</RouterLink> to introduce new
        verses.
      </p>
    </div>

    <!-- Reading walkthrough (used at both ends of the session). -->
    <div
      v-else-if="phase === 'reading_start' && currentReadingItem?.anchor"
      class="card"
    >
      <div class="meta">
        Read it through · {{ readingLabel(currentReadingItem) }} {{ readingIndex + 1 }} of
        {{ totalItems }}
      </div>
      <CardPrompt :card="currentReadingItem.anchor" :revealed="true" />
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
            {{ onLastReading ? 'Start drilling' : 'Next' }}
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
      v-else-if="phase === 'reading_end' && currentReadingItem?.anchor"
      class="card"
    >
      <div class="meta">
        Read it once more · {{ readingLabel(currentReadingItem) }} {{ readingIndex + 1 }} of
        {{ totalItems }}
      </div>
      <CardPrompt :card="currentReadingItem.anchor" :revealed="true" />
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
   memorized" escape hatch sits next to the primary "Next /
   Start drilling" action so users can skip drilling items they
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
