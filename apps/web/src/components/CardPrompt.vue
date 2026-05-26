<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { CardRender } from '@/api'
import { type DiffItem, wordDiff } from '@/lib/diff/wordDiff'

const props = defineProps<{
  card: CardRender
  revealed: boolean
}>()

function stripHtmlToText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

const userInput = ref('')
// Wipe the typed answer when the parent swaps to a new card object.
// Re-drills emit a fresh CardRender even when the cardId repeats, so
// reference-equality is enough — no need to key on cardId. Ftv cards
// pre-fill the textarea with the visible prefix so the user can keep
// typing into it — keeping or deleting it both yield the same diff
// (see `userInputForDiff`).
watch(
  () => props.card,
  (card) => {
    if (card.kind === 'Ftv' && card.composed?.ftvHtml) {
      const prefix = stripHtmlToText(card.composed.ftvHtml)
      userInput.value = prefix ? `${prefix} ` : ''
    } else {
      userInput.value = ''
    }
  },
  { immediate: true },
)

/** Verse-colour palette ported from the deck's _colours.js. The CSS vars
 *  themselves live in assets/colors.css; we pick by (verse - 1) % 10. */
const VERSE_COLOUR_VARS = [
  '--verse-c1', '--verse-c2', '--verse-c3', '--verse-c4', '--verse-c5',
  '--verse-c6', '--verse-c7', '--verse-c8', '--verse-c9', '--verse-c10',
]
function verseColourVar(verse: number): string {
  // Modulo math is always in-range for real verses (verse >= 1); the
  // non-null assertion is needed because TS sees indexed access as
  // possibly undefined. Pseudo cards (verse === 0) compute an undefined
  // index but their result is never visually consumed.
  return VERSE_COLOUR_VARS[(verse - 1) % VERSE_COLOUR_VARS.length]!
}
const verseColour = computed(() => `var(${verseColourVar(props.card.verse.verse)})`)

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
    case 'Ftv':
      // FTV's front has no ref. Hide the verse-colour pre-reveal so it
      // can't mnemonic-leak the verse number; on reveal the citation
      // and the stripe come back together.
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
    case 'HeadingPassage':
      return 'What heading is this passage under?'
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
const clubLabel = computed(() => props.card.tier ?? props.card.verse.clubs[0] ?? '')
const composedMissing = computed(() => props.card.composed === null)

/** Sentinel `verse === 0` marks a pseudo-verse card (ChapterClubList,
 *  HeadingPassage) anchored to a heading or chapter rather than a
 *  single verse. The verse-colour mnemonic doesn't apply — there's no
 *  single verse number to encode — so the stripe is suppressed by
 *  forcing `no-verse-accent` on `.card-box`. */
const isPseudoVerse = computed(() => props.card.verse.verse === 0)

/** "John 3:16-17" or "Romans 6:1-7:14" for a heading card. Each verse
 *  number gets its own verse-colour via a per-span `--active-verse-colour`
 *  override — the card-level stripe stays off (no single verse to anchor
 *  it), but the individual verse-number mnemonics still apply. */
const passageRangeHtml = computed(() => {
  const h = props.card.verse.headings[0]
  const book = escapeHtml(props.card.verse.book)
  if (!h) return `${book} ${props.card.verse.chapter}`
  const vNum = (n: number) =>
    `<span class="verse-number" style="--active-verse-colour: var(${verseColourVar(n)})">${n}</span>`
  const same = h.startChapter === h.endChapter
  const range = same
    ? `${h.startChapter}:${vNum(h.startVerse)}-${vNum(h.endVerse)}`
    : `${h.startChapter}:${vNum(h.startVerse)}-${h.endChapter}:${vNum(h.endVerse)}`
  return `${book} ${range}`
})

/** Plain-text canonical answer for the type-to-recite diff. Strips
 *  the api.bible + keyword-annotation HTML to a flat string. For Ftv
 *  the prefix shown on screen is dropped so the diff only checks the
 *  continuation the user actually had to recall. */
const expectedText = computed(() => {
  const full = stripHtmlToText(phraseHtml.value.join(' '))
  if (props.card.kind === 'Ftv') {
    const skip = props.card.verse.ftvWordCount ?? 0
    if (skip > 0) {
      const words = full.split(' ')
      return words.slice(skip).join(' ')
    }
  }
  return full
})

const NORMALIZE_NON_WORD = /[^\p{L}\p{N}']+/gu
function normalizeToken(s: string): string {
  return s.toLowerCase().replace(NORMALIZE_NON_WORD, '')
}

/** Greedily strips a leading normalised prefix from `input`, returning
 *  the raw suffix. Used so the Ftv prefill (which we ourselves put in
 *  the textarea) doesn't get diffed against the continuation as a
 *  string of extra words. */
function stripLeadingPrefix(input: string, prefix: string): string {
  if (prefix === '') return input
  const tokenRe = /\S+/g
  type Pos = { norm: string; end: number }
  const collect = (s: string): Pos[] => {
    const out: Pos[] = []
    tokenRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = tokenRe.exec(s)) !== null) {
      const norm = normalizeToken(m[0])
      if (norm === '') continue
      out.push({ norm, end: m.index + m[0].length })
    }
    return out
  }
  const inTok = collect(input)
  const prefTok = collect(prefix)
  let i = 0
  while (i < prefTok.length && i < inTok.length && prefTok[i]!.norm === inTok[i]!.norm) i++
  if (i === 0) return input
  return input.slice(inTok[i - 1]!.end).replace(/^\s+/, '')
}

const userInputForDiff = computed(() => {
  if (props.card.kind !== 'Ftv') return userInput.value
  const prefix = props.card.composed?.ftvHtml ? stripHtmlToText(props.card.composed.ftvHtml) : ''
  return stripLeadingPrefix(userInput.value, prefix)
})

const hasTypedAnswer = computed(() => userInputForDiff.value.trim() !== '')

const diffItems = computed<DiffItem[] | null>(() => {
  if (!props.revealed || !hasTypedAnswer.value) return null
  return wordDiff(expectedText.value, userInputForDiff.value)
})

const diffHtml = computed(() => {
  const items = diffItems.value
  if (!items) return ''
  return items
    .map((it) => {
      const safe = escapeHtml(it.raw)
      if (it.kind === 'match') return safe
      if (it.kind === 'missing') return `<span class="diff-missing">${safe}</span>`
      return `<span class="diff-extra">${safe}</span>`
    })
    .join(' ')
})

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
    :class="{ 'no-verse-accent': !refParts.showVerse || isPseudoVerse }"
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
        <div class="verse-text">
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
        <div class="verse-text" v-html="verseHtml" />
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
        <div class="verse-text" v-html="verseHtml" />
      </div>

      <div v-else-if="card.kind === 'VerseInHeading'" class="centered">
        <div class="ref" v-html="refHtml" />
        <hr />
        <div class="verse-text" v-html="verseHtml" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="answer">Heading: {{ headingTitle ?? '(none)' }}</div>
        </template>
        <div v-else class="placeholder">…what heading?…</div>
      </div>

      <div v-else-if="card.kind === 'VerseInClub'" class="centered">
        <div class="ref" v-html="refHtml" />
        <hr />
        <div class="verse-text" v-html="verseHtml" />
        <template v-if="revealed">
          <hr class="type" />
          <div class="answer">Club: {{ clubLabel }}</div>
        </template>
        <div v-else class="placeholder">…which club?…</div>
      </div>

      <div v-else-if="card.kind === 'Recitation'" class="centered">
        <div class="ref" v-html="refHtml" />
        <template v-if="!revealed">
          <hr />
          <textarea
            v-model="userInput"
            class="type-input"
            rows="4"
            placeholder="Type to test yourself, or just recite aloud and skip"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
          />
          <div class="placeholder">…recite the whole verse…</div>
        </template>
        <template v-else>
          <hr class="type" />
          <div v-if="diffItems" class="verse-text diff" v-html="diffHtml" />
          <div v-else class="verse-text" v-html="verseHtml" />
        </template>
      </div>

      <div v-else-if="card.kind === 'Citation'" class="centered">
        <div class="ref" v-html="refHtml" />
        <hr v-if="revealed" class="type" />
        <hr v-else />
        <div class="verse-text" v-html="verseHtml" />
      </div>

      <!-- FTV: front shows the verse's first few words as a "continue…"
           prompt; back reveals the citation and the full verse text.
           The optional type-out compares the user's input against the
           continuation only (the on-screen prefix is sliced off in
           `expectedText`) so the diff doesn't punish them for not
           re-typing what's already visible. -->
      <div v-else-if="card.kind === 'Ftv'" class="centered">
        <div v-if="revealed" class="ref" v-html="refHtml" />
        <div class="verse-text ftv" v-html="`${ftvHtml ?? ''}…`" />
        <template v-if="!revealed">
          <hr />
          <textarea
            v-model="userInput"
            class="type-input"
            rows="3"
            placeholder="Continue typing the verse, or just recite aloud and skip"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
          />
          <div class="placeholder">…continue the verse…</div>
        </template>
        <template v-else>
          <hr class="type" />
          <div v-if="diffItems" class="verse-text diff" v-html="diffHtml" />
          <div v-else class="verse-text" v-html="verseHtml" />
        </template>
      </div>

      <!-- Pseudo-verse card anchored to a heading: card-level verse-colour
           stripe stays off (no single verse to anchor), but each verse
           number in the range gets its own colour via a per-span
           `--active-verse-colour` override. Front shows the range; back
           reveals the heading title.
           TODO: passage text needs server-side bulk composition. -->
      <div v-else-if="card.kind === 'HeadingPassage'" class="centered">
        <div class="ref" v-html="passageRangeHtml" />
        <hr />
        <template v-if="revealed">
          <div class="verse-text" v-html="verseHtml" />
          <hr class="type" />
          <div class="answer">Heading: {{ headingTitle ?? '(none)' }}</div>
        </template>
        <div v-else class="placeholder">…what heading is this passage under?…</div>
      </div>

      <div v-else-if="card.kind === 'Reading'" class="centered">
        <div class="ref" v-html="refHtml" />
        <hr />
        <div class="verse-text" v-html="verseHtml" />
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
  /* Verse text inherits `--active-verse-colour`; `no-verse-accent` flips
     it back to neutral pre-reveal on the cards whose answer is the
     verse number (VerseAtVerseRef, Citation). Child elements with their
     own `color` (the ref, the .deck label, .answer, etc.) override. */
  --chip-bg: color-mix(in oklch, var(--color-text) 16%, transparent);

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
  color: var(--active-verse-colour);
}

.card-box.no-verse-accent {
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
  background: var(--chip-bg);
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
  background: var(--chip-bg);
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

/* Typography rendered via v-html. :deep() reaches inside since Vue's
   scoped CSS doesn't tag dynamically inserted nodes. The deck's
   keyword annotations (`<b>` bold-900 + underlined, `<i>` italic via
   the UA default) are the only emphasis carried through; api.bible's
   `.bd` (divine-name bold) and `.it` (translator italics) inherit
   normal styling from the parent and read as plain text. `.sc` keeps
   small caps as canonical NKJV typography for LORD. */
.verse-text :deep(b) {
  font-weight: 900;
  text-decoration: underline;
}

.verse-text :deep(.sc) {
  font-variant: small-caps;
}

.placeholder {
  color: var(--color-muted);
  font-style: italic;
}

/* Type-to-recite input. Sits below the prompt's solid hr pre-reveal;
   on flip, the textarea is replaced by the diff. Browsers auto-fill
   and auto-correct would both leak hints and rewrite the user's
   answer, so they're disabled at the element level via the template.
   `resize: vertical` lets long Recitation entries grow without
   horizontally distorting the card. */
.type-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  font-family: Arial, Helvetica, system-ui, sans-serif;
  font-size: 1rem;
  line-height: 1.4;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-bg);
  color: var(--color-text);
  resize: vertical;
  box-sizing: border-box;
}

.type-input:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

/* Word-level diff markers on the reveal side. Missing = canonical word
   the user didn't type (or got wrong); Extra = word the user typed
   that wasn't in the canonical. Both use the same Again-grade red so
   they read as "this is where you slipped" without competing with
   the verse-colour accent. */
.verse-text.diff :deep(.diff-missing) {
  color: var(--color-grade-again);
  text-decoration: underline;
}

.verse-text.diff :deep(.diff-extra) {
  color: var(--color-grade-again);
  text-decoration: line-through;
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
