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

/** Border colour for the flashcard box. Tracks the verse-number colour
 *  whenever the verse number is visible (which is always except on a
 *  Citation card before reveal); otherwise falls back to the neutral
 *  border tone so the hue doesn't leak the answer.
 *
 *  We lighten the verse hue by ~18% white via color-mix so the thin
 *  border reads at the same perceived brightness as the anti-aliased
 *  verse-number text. Without the lift the border looks noticeably
 *  darker on dark backgrounds even though the CSS colour matches. */
const borderColour = computed(() =>
  refParts.value.showVerse
    ? `color-mix(in oklch, ${verseColour.value} 82%, white)`
    : 'var(--color-border)',
)

/** Per-card visibility of each ref component. For "what chapter?" /
 *  "what book?" / "what verse?" / Citation, the asked-about parts stay
 *  blanked until reveal so the prompt doesn't leak the answer. Other
 *  kinds show the full ref. */
const refParts = computed(() => {
  const reveal = props.revealed
  switch (props.card.kind) {
    case 'VerseInBook':
      return { showBook: reveal, showChapter: true, showVerse: true }
    case 'VerseInChapter':
      return { showBook: true, showChapter: reveal, showVerse: true }
    case 'Citation':
      return { showBook: reveal, showChapter: reveal, showVerse: reveal }
    default:
      return { showBook: true, showChapter: true, showVerse: true }
  }
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Renders the reference with each part either revealed or shown as a
 *  `?` placeholder. The verse number references the same `--active-
 *  verse-colour` custom property as the card-box border, so the two
 *  are guaranteed to render with the identical CSS value. */
const refHtml = computed(() => {
  const { showBook, showChapter, showVerse } = refParts.value
  const hidden = '<span class="ref-hidden">?</span>'
  const book = showBook ? escapeHtml(props.card.verse.book) : hidden
  const chap = showChapter ? String(props.card.verse.chapter) : hidden
  const verse = showVerse
    ? `<span class="verse-number">${props.card.verse.verse}</span>`
    : hidden
  return `${book} ${chap}:${verse}`
})

const promptLabel = computed(() => {
  switch (props.card.kind) {
    case 'PhraseFill':
      return `Fill in phrase ${props.card.position! + 1}`
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

    <!-- The bordered content box wears the verse-number colour on its
         edge so each verse has a consistent visual identity. When the
         verse number is hidden (Citation pre-reveal) the border falls
         back to neutral so it doesn't leak the answer. Both the border
         and the verse-number span resolve `--active-verse-colour` from
         this scope, guaranteeing they render the same hue. -->
    <div class="card-box" :style="{ '--active-verse-colour': verseColour, borderColor: borderColour }">
      <div v-if="composedMissing" class="placeholder">
        Canonical text unavailable. Set <code>BIBLE_API_KEY</code> on the server to render NKJV verses.
      </div>

      <!-- v-html renders api.bible's NKJV typography (small caps for LORD,
           translator italics, divine-name bold) layered with the user's
           keyword <b>/<i> annotations. Source is the server-composed
           output, never user input. -->
      <template v-else>
      <div v-if="card.kind === 'PhraseFill'" class="centered">
        <div class="ref small" v-html="refHtml" />
        <div class="verse-text" :style="{ color: verseColour }">
          <template v-for="(phrase, i) in phraseHtml" :key="i">
            <span v-if="i === card.position && !revealed" class="phrase-hidden">___</span><span v-else v-html="phrase" /><template v-if="i &lt; phraseHtml.length - 1">{{ ' ' }}</template>
          </template>
        </div>
      </div>

      <div v-else-if="card.kind === 'VerseAtVerseRef'" class="centered">
        <div class="ref" v-html="refHtml" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        </template>
        <div v-else class="placeholder">…recite the verse…</div>
      </div>

      <!-- Ref-as-answer cards: ref is always present, but the asked-about
           part(s) render as `?` until reveal. The `?` placeholder is the
           prompt itself — no separate "what chapter?" hint needed. hr
           appears on reveal as the prompt/answer divider. -->
      <div v-else-if="card.kind === 'VerseInChapter' || card.kind === 'VerseInBook'" class="centered">
        <div class="ref" v-html="refHtml" />
        <hr v-if="revealed" class="type" />
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
      </div>

      <div v-else-if="card.kind === 'VerseInHeading'" class="centered">
        <div class="ref small" v-html="refHtml" />
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="answer">Heading: {{ headingTitle ?? '(none)' }}</div>
        </template>
        <div v-else class="placeholder">…what heading?…</div>
      </div>

      <div v-else-if="card.kind === 'VerseInClub'" class="centered">
        <div class="ref small" v-html="refHtml" />
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="answer">Club: {{ clubLabel }}</div>
        </template>
        <div v-else class="placeholder">…which club?…</div>
      </div>

      <div v-else-if="card.kind === 'Recitation'" class="centered">
        <div class="ref" v-html="refHtml" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        </template>
        <div v-else class="placeholder">…recite the whole verse…</div>
      </div>

      <div v-else-if="card.kind === 'Citation'" class="centered">
        <div class="ref" v-html="refHtml" />
        <hr v-if="revealed" class="type" />
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
      </div>

      <div v-else-if="card.kind === 'Ftv'" class="centered">
        <div v-if="revealed && card.withCitation" class="ref" v-html="refHtml" />
        <div class="verse-text ftv" :style="{ color: verseColour }" v-html="`${ftvHtml ?? ''}…`" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
        </template>
        <div v-else class="placeholder">…continue the verse…</div>
      </div>

      <div v-else-if="card.kind === 'Reading'" class="centered">
        <div class="ref" v-html="refHtml" />
        <div class="verse-text" :style="{ color: verseColour }" v-html="verseHtml" />
      </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.prompt {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}

.meta {
  font-size: 0.85rem;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  text-align: center;
}

/* Verse-coloured inner box — the flashcard frame. Sits inside the
   outer SessionView card surface, so it shares that white background
   and only the border tints. Width and weight are tuned so the line
   reads with the same perceived saturation as the verse-number digit
   (a thin line at the deck's OKLCH lightness looks noticeably darker
   than anti-aliased text on either light or dark backgrounds).

   Fills the available height inside .prompt so the inner frame
   tracks the outer card. Content is centred vertically so short
   verses don't pin themselves to the top. */
.card-box {
  border-width: 5px;
  border-style: solid;
  border-radius: 10px;
  padding: 2rem 1.75rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1rem;
  flex: 1;
  min-height: 0;
}

@media (max-width: 600px) {
  .card-box {
    border-width: 4px;
    padding: 1.25rem 1rem;
    border-radius: 8px;
  }
}

/* PhraseFill blanks render inline within the verse-text run so the
   surrounding phrases keep flowing naturally. */
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
  align-items: center;
}

/* Headline-style ref for cards where the reference is the focus
   (VerseAtVerseRef / Recitation prompts, Citation / VerseInChapter /
   VerseInBook answers). Centered and large like the Anki deck's
   centered 20px body — scaled up here to suit the bigger card area. */
.ref {
  font-weight: 600;
  color: var(--color-accent);
  font-size: 1.75rem;
  text-align: center;
  align-self: stretch;
  letter-spacing: 0.01em;
}

/* Context-style ref for cards where the reference is just a label
   alongside the verse text (PhraseFill, VerseInHeading, VerseInClub).
   Kept compact and muted so it doesn't compete with the main prompt. */
.ref.small {
  font-size: 0.95rem;
  color: var(--color-muted);
  font-weight: 400;
  text-align: center;
  align-self: stretch;
}

/* `?` placeholder for ref parts that are the answer being tested. Slightly
   muted vs the surrounding revealed text so the question is visually clear
   without being a giant chip like phrase-hidden. */
.ref :deep(.ref-hidden) {
  background: var(--color-accent-soft);
  border-radius: 4px;
  padding: 0 0.4rem;
  color: var(--color-muted);
  font-weight: 600;
}

/* Verse-number digit inside the ref. Pulls from the same custom
   property as the card-box border so the two always match. */
.ref :deep(.verse-number) {
  color: var(--active-verse-colour);
}

.verse-text {
  font-size: 1.15rem;
  line-height: 1.6;
  text-align: center;
  align-self: stretch;
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
