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

/** Verse text colour. Suppressed (falls back to neutral text) on cards
 *  whose answer is the verse number itself — VerseAtVerseRef and
 *  Citation pre-reveal — so the verse-colour palette doesn't leak which
 *  verse this is. Same gate used by the top-stripe accent. */
const verseTextColour = computed(() =>
  refParts.value.showVerse ? verseColour.value : undefined,
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
    case 'VerseAtVerseRef':
      return { showBook: true, showChapter: true, showVerse: reveal }
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
 *  are guaranteed to render with the identical CSS value.
 *
 *  When a ref part is the asked-about answer (was a `?` on the prompt
 *  side), the revealed value is wrapped in `.ref-revealed` so it carries
 *  the same soft-accent chip the `?` placeholder did — the eye lands on
 *  the part that just filled in. */
const refHtml = computed(() => {
  const { showBook, showChapter, showVerse } = refParts.value
  const kind = props.card.kind
  const hidden = '<span class="ref-hidden">?</span>'
  const wrap = (inner: string) => `<span class="ref-revealed">${inner}</span>`
  const isAnswer = (part: 'book' | 'chap' | 'verse') => {
    if (!props.revealed) return false
    if (kind === 'Citation') return true
    if (kind === 'VerseInBook') return part === 'book'
    if (kind === 'VerseInChapter') return part === 'chap'
    if (kind === 'VerseAtVerseRef') return part === 'verse'
    return false
  }
  const bookText = escapeHtml(props.card.verse.book)
  const chapText = String(props.card.verse.chapter)
  const verseText = `<span class="verse-number">${props.card.verse.verse}</span>`
  const book = !showBook ? hidden : (isAnswer('book') ? wrap(bookText) : bookText)
  const chap = !showChapter ? hidden : (isAnswer('chap') ? wrap(chapText) : chapText)
  const verse = !showVerse ? hidden : (isAnswer('verse') ? wrap(verseText) : verseText)
  return `${book} ${chap}:${verse}`
})

const promptLabel = computed(() => {
  switch (props.card.kind) {
    case 'PhraseFill':
      return `Fill in phrase ${props.card.position! + 1}`
    case 'VerseAtVerseRef':
      return 'What verse?'
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
  <!-- The bordered content box carries a thin verse-coloured top stripe
       so each verse has a consistent visual identity, sitting on a
       plain card surface — same shape Anki's Verse note type renders
       with (centred Arial, .deck label top-right, solid <hr> between
       ref and text, dotted <hr class="type"> as the prompt/answer
       divider). The verse-number span and the top stripe both pull
       `--active-verse-colour` from this scope, so they always agree. -->
  <div
    class="card-box"
    :class="{ 'no-verse-accent': !refParts.showVerse }"
    :style="{ '--active-verse-colour': verseColour }"
  >
    <div class="deck">{{ promptLabel }}</div>

    <div v-if="composedMissing" class="placeholder">
      Canonical text unavailable. Set <code>BIBLE_API_KEY</code> on the server to render NKJV verses.
    </div>

    <!-- v-html renders api.bible's NKJV typography (small caps for LORD,
         translator italics, divine-name bold) layered with the user's
         keyword <b>/<i> annotations. Source is the server-composed
         output, never user input. -->
    <template v-else>
    <div v-if="card.kind === 'PhraseFill'" class="centered">
      <div class="ref" v-html="refHtml" />
      <hr />
      <div class="verse-text" :style="{ color: verseTextColour }">
        <template v-for="(phrase, i) in phraseHtml" :key="i">
          <span v-if="i === card.position && !revealed" class="phrase-hidden">___</span><span v-else-if="i === card.position" class="phrase-revealed" v-html="phrase" /><span v-else v-html="phrase" /><template v-if="i &lt; phraseHtml.length - 1">{{ ' ' }}</template>
        </template>
      </div>
    </div>

    <!-- VerseAtVerseRef is the atomic "what verse?" card — verse text
         is the prompt, verse number is the answer. Same layout
         pattern as VerseInChapter / VerseInBook / Citation. -->
    <div v-else-if="card.kind === 'VerseAtVerseRef'" class="centered">
      <div class="ref" v-html="refHtml" />
      <hr v-if="revealed" class="type" />
      <hr v-else />
      <div class="verse-text" :style="{ color: verseTextColour }" v-html="verseHtml" />
    </div>

    <!-- Ref-as-answer cards: ref is always present, but the asked-about
         part(s) render as `?` until reveal. The `?` placeholder is the
         prompt itself — no separate "what chapter?" hint needed. The
         dotted hr appears on reveal as the prompt/answer divider; a
         solid hr stands in pre-reveal to anchor ref above text. -->
    <div v-else-if="card.kind === 'VerseInChapter' || card.kind === 'VerseInBook'" class="centered">
      <div class="ref" v-html="refHtml" />
      <hr v-if="revealed" class="type" />
      <hr v-else />
      <div class="verse-text" :style="{ color: verseTextColour }" v-html="verseHtml" />
    </div>

    <div v-else-if="card.kind === 'VerseInHeading'" class="centered">
      <div class="ref" v-html="refHtml" />
      <hr />
      <div class="verse-text" :style="{ color: verseTextColour }" v-html="verseHtml" />
      <template v-if="revealed">
        <hr class="type" />
        <div class="answer">Heading: {{ headingTitle ?? '(none)' }}</div>
      </template>
      <div v-else class="placeholder">…what heading?…</div>
    </div>

    <div v-else-if="card.kind === 'VerseInClub'" class="centered">
      <div class="ref" v-html="refHtml" />
      <hr />
      <div class="verse-text" :style="{ color: verseTextColour }" v-html="verseHtml" />
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
        <div class="verse-text" :style="{ color: verseTextColour }" v-html="verseHtml" />
      </template>
      <div v-else class="placeholder">…recite the whole verse…</div>
    </div>

    <div v-else-if="card.kind === 'Citation'" class="centered">
      <div class="ref" v-html="refHtml" />
      <hr v-if="revealed" class="type" />
      <hr v-else />
      <div class="verse-text" :style="{ color: verseTextColour }" v-html="verseHtml" />
    </div>

    <div v-else-if="card.kind === 'Ftv'" class="centered">
      <div v-if="revealed && card.withCitation" class="ref" v-html="refHtml" />
      <div class="verse-text ftv" :style="{ color: verseTextColour }" v-html="`${ftvHtml ?? ''}…`" />
      <template v-if="revealed">
        <hr class="type" />
        <div class="verse-text" :style="{ color: verseTextColour }" v-html="verseHtml" />
      </template>
      <div v-else class="placeholder">…continue the verse…</div>
    </div>

    <div v-else-if="card.kind === 'Reading'" class="centered">
      <div class="ref" v-html="refHtml" />
      <hr />
      <div class="verse-text" :style="{ color: verseTextColour }" v-html="verseHtml" />
    </div>
    </template>
  </div>
</template>

<style scoped>
/* Anki-faithful card surface: Arial body, plain bg-card surface, a
   single 1px neutral border, a thin verse-coloured stripe along the
   top edge for identity, and centred content. Mirrors the Verse note
   type's baseline CSS (Arial 20px, black-on-white, centred, dotted
   hr.type) layered onto our themed colour tokens so it adapts to
   light/dark via the same vars. */
.card-box {
  position: relative;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 2.5rem 2rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  font-family: Arial, Helvetica, system-ui, sans-serif;
  font-size: 1.25rem;
  line-height: 1.6;
  text-align: center;
  color: var(--color-text);
}

/* Verse-coloured top stripe — sits inside the rounded corners via the
   same radius on its own top edge. Hidden on cards where revealing the
   verse colour would leak the answer (Citation pre-reveal, etc.). The
   card surface itself stays the same front/back so the reveal doesn't
   flicker; the answer state shows through the chips and the dotted
   `hr.type` divider tinting picked up below. */
.card-box::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: var(--active-verse-colour);
  border-radius: 6px 6px 0 0;
}

.card-box.no-verse-accent::before {
  display: none;
}

@media (max-width: 600px) {
  .card-box {
    padding: 2rem 1.25rem 1.5rem;
    font-size: 1.1rem;
  }
}

/* Anki's `.deck { float: right; font-size: 10px; }`, restated with
   absolute positioning so it sits in the top-right corner of the card
   surface without disrupting the centred content flow. Uppercased +
   tracked so it reads as a label, not a sentence. */
.deck {
  position: absolute;
  top: 0.65rem;
  right: 0.85rem;
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-muted);
  font-family: Arial, Helvetica, system-ui, sans-serif;
}

/* PhraseFill blanks (and their reveal-side counterpart) render inline
   within the verse-text run so the surrounding phrases keep flowing
   naturally. The chip reads as a marker highlight rather than a UI
   tag: em-scaled padding so it tracks the surrounding text size, a
   soft radius, and `box-decoration-break: clone` so a multi-line
   revealed phrase gets a fully-rounded chip on every line. The 0.1em
   vertical padding stays inside `.verse-text`'s 1.6 line-height so
   it doesn't push lines apart.

   Chip background derives from `--color-text` rather than a fixed
   accent token so its contrast stays the same in light and dark mode
   (the accent-soft palette flips to near-bg-card values in dark, which
   made the chip nearly invisible). */
.phrase-hidden,
.phrase-revealed {
  background: color-mix(in oklch, var(--color-text) 16%, transparent);
  border-radius: 0.25em;
  padding: 0.1em 0.3em;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

.phrase-hidden {
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

/* Single ref style across all card kinds. A moderate headline — bigger
   than body so it reads as the title of the card, smaller than a
   dominant header so it doesn't overpower the verse text on cards
   where the verse is the real focus (PhraseFill / VerseInHeading).
   Book + chapter render in the neutral text colour so the only accent
   in the line is the verse-number digit (which picks up the verse
   colour via its own inline rule). */
.ref {
  font-weight: 600;
  color: var(--color-text);
  font-size: 1.4rem;
  text-align: center;
  align-self: stretch;
  letter-spacing: 0.01em;
}

/* `?` placeholder for ref parts that are the answer being tested, and
   its reveal-side counterpart on the same ref. Em-scaled padding keeps
   the chip proportional whether the ref is the big headline (1.75rem)
   or the small label (0.95rem). Same foreground-mix background as the
   phrase chip so all four chip variants read identically. */
.ref :deep(.ref-hidden),
.ref :deep(.ref-revealed) {
  background: color-mix(in oklch, var(--color-text) 16%, transparent);
  border-radius: 0.25em;
  padding: 0.1em 0.3em;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

.ref :deep(.ref-hidden) {
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

/* Solid hr — within-card section divider (ref above, verse text below).
   Anki templates use a bare `<hr>` for this; we keep the same
   semantics so the layout reads identically to a printed Anki card. */
.card-box :deep(hr) {
  width: 100%;
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 0.25rem 0;
}

/* Dotted hr.type — the prompt/answer divider, ported from the Anki
   deck's `hr.type`. Appears on reveal to mark "below this line is
   the answer / the typed-in check / the supporting context". Stays
   on the neutral border tone so it reads as a UI divider rather than
   carrying verse-colour weight (some hues — verse 1's red, verse 5's
   yellow — would otherwise read as alarm/warning, not "answer"). */
.card-box :deep(hr.type) {
  border-top: 1px dotted var(--color-border);
}
</style>
