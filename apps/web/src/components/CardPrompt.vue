<script setup lang="ts">
import { computed } from 'vue'

import type { CardRender } from '@/api'

const props = defineProps<{
  card: CardRender
  revealed: boolean
}>()

/** Verse-colour palette ported from the deck's _colours.js. The CSS vars
 *  themselves live in assets/colors.css; we pick by (verse - 1) % 10. */
const VERSE_COLOUR_VARS = [
  '--verse-c1', '--verse-c2', '--verse-c3', '--verse-c4', '--verse-c5',
  '--verse-c6', '--verse-c7', '--verse-c8', '--verse-c9', '--verse-c10',
]
const verseColour = computed(() => {
  const idx = (props.card.verse.verse - 1) % VERSE_COLOUR_VARS.length
  return `var(${VERSE_COLOUR_VARS[idx]})`
})

const refPrefix = computed(() => `${props.card.verse.book} ${props.card.verse.chapter}:`)
const refVerseNum = computed(() => props.card.verse.verse)

const promptLabel = computed(() => {
  switch (props.card.kind) {
    case 'PhraseFill':
      return `Fill in phrase ${props.card.position! + 1}`
    case 'PhraseChain':
      return `What comes after phrase ${props.card.position}?`
    case 'VerseAtVerseRef':
      return 'Recite this verse'
    case 'VerseInChapter':
      return 'What chapter?'
    case 'VerseInBook':
      return 'What book?'
    case 'VerseInHeading':
      return 'What heading?'
    case 'VerseInClub':
      return 'What club?'
    case 'Recitation':
      return 'Recite the whole verse + reference'
    case 'Citation':
      return 'What is the reference?'
    case 'Ftv':
      return 'Continue from these first words'
    case 'Reading':
      return 'Reading'
    default:
      return 'Card'
  }
})

const phraseHtml = computed(() => props.card.composed?.phraseHtml ?? [])
const verseHtml = computed(() => phraseHtml.value.join(' '))
const ftvHtml = computed(() => props.card.composed?.ftvHtml ?? null)
const headingTitle = computed(() => props.card.composed?.headings[0]?.title ?? null)
const clubLabel = computed(() => props.card.verse.clubs[0] ?? '')
const composedMissing = computed(() => props.card.composed === null)
</script>

<template>
  <div class="prompt">
    <div class="meta">{{ promptLabel }}</div>

    <div v-if="composedMissing" class="placeholder">
      Canonical text unavailable. Set <code>BIBLE_API_KEY</code> on the server to render NKJV verses.
    </div>

    <!-- v-html renders api.bible's NKJV typography (small caps for LORD,
         translator italics, divine-name bold) layered with the user's
         keyword <b>/<i> annotations. Source is the server-composed
         output, never user input. -->
    <template v-else>
      <div v-if="card.kind === 'PhraseFill'" class="centered">
        <div class="verse-text" :style="{ color: verseColour }">
          <template v-for="(phrase, i) in phraseHtml" :key="i">
            <span v-if="i === card.position && !revealed" class="phrase-hidden">___</span><span v-else v-html="phrase" /><template v-if="i &lt; phraseHtml.length - 1">{{ ' ' }}</template>
          </template>
        </div>
        <div class="ref small">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
      </div>

      <div v-else-if="card.kind === 'PhraseChain'" class="centered">
        <div class="verse-text" :style="{ color: verseColour }">
          <span v-html="phraseHtml[card.position! - 1]" />{{ ' ' }}<span v-if="revealed" class="phrase-hidden" v-html="phraseHtml[card.position!]" /><span v-else class="phrase-hidden">___</span>
        </div>
        <div class="ref small">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
      </div>

      <div v-else-if="card.kind === 'VerseAtVerseRef'" class="centered">
        <div class="ref">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
        <template v-if="revealed">
          <hr class="type" />
          <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        </template>
        <div v-else class="placeholder">…recite the verse…</div>
      </div>

      <div v-else-if="card.kind === 'VerseInChapter' || card.kind === 'VerseInBook'" class="centered">
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="ref">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
        </template>
        <div v-else class="placeholder">…what {{ card.kind === 'VerseInBook' ? 'book' : 'chapter' }}?…</div>
      </div>

      <div v-else-if="card.kind === 'VerseInHeading'" class="centered">
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        <div class="ref small">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
        <template v-if="revealed">
          <hr class="type" />
          <div class="answer">Heading: {{ headingTitle ?? '(none)' }}</div>
        </template>
        <div v-else class="placeholder">…what heading?…</div>
      </div>

      <div v-else-if="card.kind === 'VerseInClub'" class="centered">
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        <div class="ref small">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
        <template v-if="revealed">
          <hr class="type" />
          <div class="answer">Club: {{ clubLabel }}</div>
        </template>
        <div v-else class="placeholder">…which club?…</div>
      </div>

      <div v-else-if="card.kind === 'Recitation'" class="centered">
        <div class="ref">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
        <template v-if="revealed">
          <hr class="type" />
          <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        </template>
        <div v-else class="placeholder">…recite the whole verse…</div>
      </div>

      <div v-else-if="card.kind === 'Citation'" class="centered">
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="ref">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
        </template>
        <div v-else class="placeholder">…what is the reference?…</div>
      </div>

      <div v-else-if="card.kind === 'Ftv'" class="centered">
        <div class="verse-text ftv" :style="{ color: verseColour }" v-html="`${ftvHtml ?? ''}…`" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
          <div v-if="card.withCitation" class="ref">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
        </template>
        <div v-else class="placeholder">…continue the verse…</div>
      </div>

      <div v-else-if="card.kind === 'Reading'" class="centered">
        <div class="ref">{{ refPrefix }}<span :style="{ color: verseColour }">{{ refVerseNum }}</span></div>
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.prompt {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-height: 12rem;
}

.meta {
  font-size: 0.85rem;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* PhraseFill/PhraseChain blanks render inline within the verse-text run
   so the surrounding phrases keep flowing naturally. */
.phrase-hidden {
  background: var(--color-accent-soft);
  border-radius: 4px;
  padding: 0 0.4rem;
  /* Cancel the verse colour cascade on the placeholder text only — the
     chrome stays visible regardless of the verse hue. */
  color: var(--color-text);
}

.centered {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: flex-start;
}

.ref {
  font-weight: 500;
  color: var(--color-accent);
}

.ref.small {
  font-size: 0.9rem;
  color: var(--color-muted);
  font-weight: 400;
}

.verse-text {
  font-size: 1.15rem;
  line-height: 1.6;
}

.verse-text.ftv {
  font-style: italic;
}

/* Typography rendered via v-html — both api.bible's editorial classes
   (.sc small caps for LORD, .bd divine-name bold, .it translator
   italics) and the deck's user-annotation tags (<b>/<i>). :deep()
   reaches inside since Vue's scoped CSS doesn't tag dynamically
   inserted nodes. */
/* User keyword annotations: deck convention is bold-900 + underlined.
   api.bible's divine-name `.bd` stays bold-only (no underline). */
.verse-text :deep(b) {
  font-weight: 900;
  text-decoration: underline;
}

.verse-text :deep(.bd) {
  font-weight: 700;
}

.verse-text :deep(i),
.verse-text :deep(.it) {
  font-style: italic;
}

.verse-text :deep(.sc) {
  font-variant: small-caps;
}

.placeholder {
  color: var(--color-muted);
  font-style: italic;
}

.answer {
  background: var(--color-success-bg);
  color: var(--color-success);
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  font-weight: 500;
}

code {
  background: var(--color-accent-soft);
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  font-family: monospace;
}

/* Prompt-vs-answer divider, ported from the Anki deck's `hr.type` —
   dotted to distinguish from any future solid-rule usage. Matches the
   typography hint on the Anki cards. */
hr.type {
  width: 100%;
  border: none;
  border-top: 1px dotted var(--color-border);
  margin: 0.25rem 0;
}
</style>
