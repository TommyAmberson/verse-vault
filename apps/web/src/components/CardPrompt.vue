<script setup lang="ts">
import { computed } from 'vue'

import type { CardRender } from '@/api'

const props = defineProps<{
  card: CardRender
  revealed: boolean
}>()

const ref = computed(() => `${props.card.verse.book} ${props.card.verse.chapter}:${props.card.verse.verse}`)

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
      <div v-if="card.kind === 'PhraseFill'" class="phrases">
        <template v-for="(phrase, i) in phraseHtml" :key="i">
          <div v-if="i === card.position && !revealed" class="phrase phrase-hidden">___</div>
          <div v-else class="phrase" v-html="phrase" />
        </template>
        <div class="ref small">{{ ref }}</div>
      </div>

      <div v-else-if="card.kind === 'PhraseChain'" class="phrases">
        <div class="phrase" v-html="phraseHtml[card.position! - 1]" />
        <div v-if="revealed" class="phrase phrase-hidden" v-html="phraseHtml[card.position!]" />
        <div v-else class="phrase phrase-hidden">___</div>
        <div class="ref small">{{ ref }}</div>
      </div>

      <div v-else-if="card.kind === 'VerseAtVerseRef'" class="centered">
        <div class="ref">{{ ref }}</div>
        <div v-if="revealed" class="verse-text" v-html="verseHtml" />
        <div v-else class="placeholder">…recite the verse…</div>
      </div>

      <div v-else-if="card.kind === 'VerseInChapter' || card.kind === 'VerseInBook'" class="centered">
        <div class="verse-text" v-html="verseHtml" />
        <div v-if="revealed" class="ref">{{ ref }}</div>
        <div v-else class="placeholder">…what {{ card.kind === 'VerseInBook' ? 'book' : 'chapter' }}?…</div>
      </div>

      <div v-else-if="card.kind === 'VerseInHeading'" class="centered">
        <div class="verse-text" v-html="verseHtml" />
        <div class="ref small">{{ ref }}</div>
        <div v-if="revealed" class="answer">Heading: {{ headingTitle ?? '(none)' }}</div>
        <div v-else class="placeholder">…what heading?…</div>
      </div>

      <div v-else-if="card.kind === 'VerseInClub'" class="centered">
        <div class="verse-text" v-html="verseHtml" />
        <div class="ref small">{{ ref }}</div>
        <div v-if="revealed" class="answer">Club: {{ clubLabel }}</div>
        <div v-else class="placeholder">…which club?…</div>
      </div>

      <div v-else-if="card.kind === 'Recitation'" class="centered">
        <div class="ref">{{ ref }}</div>
        <div v-if="revealed" class="verse-text" v-html="verseHtml" />
        <div v-else class="placeholder">…recite the whole verse…</div>
      </div>

      <div v-else-if="card.kind === 'Citation'" class="centered">
        <div class="verse-text" v-html="verseHtml" />
        <div v-if="revealed" class="ref">{{ ref }}</div>
        <div v-else class="placeholder">…what is the reference?…</div>
      </div>

      <div v-else-if="card.kind === 'Ftv'" class="centered">
        <div class="verse-text ftv" v-html="`${ftvHtml ?? ''}…`" />
        <div v-if="revealed" class="verse-text" v-html="verseHtml" />
        <div v-else class="placeholder">…continue the verse…</div>
        <div v-if="revealed && card.withCitation" class="ref">{{ ref }}</div>
      </div>

      <div v-else-if="card.kind === 'Reading'" class="centered">
        <div class="ref">{{ ref }}</div>
        <div class="verse-text" v-html="verseHtml" />
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

.phrases {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.phrase {
  font-size: 1.15rem;
  line-height: 1.5;
}

.phrase-hidden {
  background: var(--color-accent-soft);
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
  display: inline-block;
  width: fit-content;
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
.verse-text :deep(b),
.phrase :deep(b),
.verse-text :deep(.bd),
.phrase :deep(.bd) {
  font-weight: 600;
}

.verse-text :deep(i),
.phrase :deep(i),
.verse-text :deep(.it),
.phrase :deep(.it) {
  font-style: italic;
}

.verse-text :deep(.sc),
.phrase :deep(.sc) {
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
</style>
