<script setup lang="ts">
import { onMounted, ref } from 'vue'

import ScopeLevelSelector from '@/components/ScopeLevelSelector.vue'
import {
  type ChapterListScope,
  type ClubStatus,
  type ClubTier,
  type TierScope,
  type YearSettings,
  type YearView,
  api,
} from '@/api'

const CLUB_TIERS: ClubTier[] = ['150', '300', 'full']

const TIER_LABELS: Record<ClubTier, string> = {
  '150': 'Club 150',
  '300': 'Club 300',
  full: 'Full',
}

const STATUS_LABELS: Record<ClubStatus, string> = {
  active: 'Active',
  maintenance: 'Maintenance',
  paused: 'Paused',
}

// All four scope tracks share the same 4-stop shape (chapter-list is
// missing the Full stop). Stops are ordered: Off ── 150 ── 300 ── Full.
const TIER_SCOPE_LEVELS: { value: TierScope; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'up150', label: '150' },
  { value: 'up300', label: '300' },
  { value: 'all', label: 'Full' },
]

const CHAPTER_LIST_LEVELS: { value: ChapterListScope; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'up150', label: '150' },
  { value: 'up300', label: '300' },
]

const NEW_DESCRIPTIONS: Record<TierScope, string> = {
  off: 'No tier is introducing new verses.',
  up150: 'Memorizing Club 150 verses.',
  up300: 'Memorizing Club 150 and Club 300 verses.',
  all: 'Memorizing every tier, including Full.',
}

const REVIEW_DESCRIPTIONS: Record<TierScope, string> = {
  off: 'No reviews surfaced.',
  up150: 'Reviewing Club 150 verses.',
  up300: 'Reviewing Club 150 and Club 300 verses.',
  all: 'Reviewing every tier, including Full.',
}

const CLUB_CARD_DESCRIPTIONS: Record<TierScope, string> = {
  off: 'No "which club?" prompts.',
  up150: 'Asks for Club 150 verses only.',
  up300: 'Asks for Club 150 and Club 300 verses (not Full).',
  all: 'Asks for every verse, including Full-tier.',
}

const CHAPTER_LIST_DESCRIPTIONS: Record<ChapterListScope, string> = {
  off: 'No chapter-list prompts.',
  up150: 'One card per chapter listing its Club 150 verses.',
  up300: 'Two cards per chapter: Club 150 list and Club 300 list.',
}

interface YearCard {
  view: YearView
  draft: YearSettings
  saving: boolean
}

const cards = ref<YearCard[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

async function refresh() {
  loading.value = true
  error.value = null
  try {
    const res = await api.getYears()
    cards.value = res.years.map((view) => ({
      view,
      draft: { ...view.settings },
      saving: false,
    }))
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function onSave(card: YearCard) {
  card.saving = true
  try {
    await api.updateYearSettings(card.view.materialId, card.draft)
    await refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    card.saving = false
  }
}

function settingsAreDirty(card: YearCard): boolean {
  const { draft, view } = card
  return (
    draft.headings !== view.settings.headings ||
    draft.ftv !== view.settings.ftv ||
    draft.newScope !== view.settings.newScope ||
    draft.reviewScope !== view.settings.reviewScope ||
    draft.clubCardScope !== view.settings.clubCardScope ||
    draft.chapterListScope !== view.settings.chapterListScope ||
    draft.lessonBatchSize !== view.settings.lessonBatchSize
  )
}

function tierLabel(tier: ClubTier): string {
  return TIER_LABELS[tier]
}

function statusClass(status: ClubStatus): string {
  return `status-chip status-${status}`
}

onMounted(refresh)
</script>

<template>
  <div class="material">
    <h2>Material</h2>
    <div v-if="error" class="banner banner-error">{{ error }}</div>
    <div v-if="loading" class="status">Loading…</div>
    <div v-else-if="cards.length === 0" class="status">
      You're not enrolled in any year yet.
    </div>
    <div v-else class="years">
      <article v-for="card in cards" :key="card.view.materialId" class="year-card">
        <header class="year-header">
          <h3>{{ card.view.materialId }}</h3>
          <div class="tier-summary">
            <span
              v-for="tier in CLUB_TIERS"
              :key="tier"
              class="tier-pill"
              :class="`tier-status-${card.view.clubs[tier].status}`"
            >
              <span class="tier-pill-name">{{ tierLabel(tier) }}</span>
              <span class="tier-pill-count">{{ card.view.clubs[tier].cardCount }}</span>
              <span :class="statusClass(card.view.clubs[tier].status)">
                {{ STATUS_LABELS[card.view.clubs[tier].status] }}
              </span>
            </span>
          </div>
        </header>

        <section class="settings">
          <div class="section-title">Study scopes</div>
          <div class="scope-stack">
            <div class="scope-row">
              <span class="scope-row-label">Memorize new verses</span>
              <ScopeLevelSelector
                v-model="card.draft.newScope"
                :levels="TIER_SCOPE_LEVELS"
                :description="NEW_DESCRIPTIONS[card.draft.newScope]"
                :disabled="card.saving"
                aria-label="New verses scope"
              />
            </div>
            <div class="scope-row">
              <span class="scope-row-label">Review existing verses</span>
              <ScopeLevelSelector
                v-model="card.draft.reviewScope"
                :levels="TIER_SCOPE_LEVELS"
                :description="REVIEW_DESCRIPTIONS[card.draft.reviewScope]"
                :disabled="card.saving"
                aria-label="Review scope"
              />
              <p class="scope-fineprint">
                A tier in both becomes Active; review-only becomes Maintenance; neither is
                Paused.
              </p>
            </div>
          </div>

          <div class="section-title section-title-spaced">Card kinds</div>
          <div class="scope-stack">
            <label class="toggle">
              <input
                v-model="card.draft.headings"
                type="checkbox"
                :disabled="card.saving"
              />
              <span>Headings</span>
            </label>
            <label class="toggle">
              <input
                v-model="card.draft.ftv"
                type="checkbox"
                :disabled="card.saving"
              />
              <span>FTV (finish-the-verse) prompts</span>
            </label>
            <div class="scope-row">
              <span class="scope-row-label">"Which club is this verse in?" prompts</span>
              <ScopeLevelSelector
                v-model="card.draft.clubCardScope"
                :levels="TIER_SCOPE_LEVELS"
                :description="CLUB_CARD_DESCRIPTIONS[card.draft.clubCardScope]"
                :disabled="card.saving"
                aria-label="Per-verse club-card scope"
              />
            </div>
            <div class="scope-row">
              <span class="scope-row-label">Chapter-list prompts</span>
              <ScopeLevelSelector
                v-model="card.draft.chapterListScope"
                :levels="CHAPTER_LIST_LEVELS"
                :description="CHAPTER_LIST_DESCRIPTIONS[card.draft.chapterListScope]"
                :disabled="card.saving"
                aria-label="Chapter-list scope"
              />
            </div>
          </div>

          <div class="section-title section-title-spaced">Session</div>
          <label class="number-row">
            <span>Verses per memorize session</span>
            <input
              v-model.number="card.draft.lessonBatchSize"
              type="number"
              min="1"
              max="10"
              :disabled="card.saving"
            />
          </label>

          <button
            type="button"
            class="save-button"
            :disabled="!settingsAreDirty(card) || card.saving"
            @click="onSave(card)"
          >
            {{ card.saving ? 'Saving…' : 'Save settings' }}
          </button>
        </section>
      </article>
    </div>
  </div>
</template>

<style scoped>
.material {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

h2 {
  font-size: 1.5rem;
  margin: 0;
}

.banner {
  padding: 0.75rem 1rem;
  border-radius: 6px;
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

.years {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.year-card {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.year-header {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.year-header h3 {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
}

.tier-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.tier-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg);
  font-size: 0.82rem;
}

.tier-pill-name {
  font-weight: 500;
  color: var(--color-text);
}

.tier-pill-count {
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}

.status-chip {
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
}

.status-active {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.status-maintenance {
  background: var(--color-grade-hard-bg);
  color: var(--color-grade-hard);
}

.status-paused {
  background: var(--color-bg-card);
  color: var(--color-muted);
  border: 1px solid var(--color-border);
}

.section-title {
  font-size: 0.78rem;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.section-title-spaced {
  margin-top: 0.75rem;
}

.settings {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.scope-stack {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.toggle input[type='checkbox'] {
  accent-color: var(--color-accent);
}

.scope-row {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.scope-row-label {
  font-size: 0.95rem;
  color: var(--color-text);
}

.scope-fineprint {
  margin: 0;
  font-size: 0.78rem;
  color: var(--color-muted);
  font-style: italic;
}

.number-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.number-row input {
  padding: 0.25rem 0.5rem;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.9rem;
  width: 4rem;
  font-variant-numeric: tabular-nums;
}

.save-button {
  align-self: flex-start;
  background: var(--color-accent);
  color: var(--color-on-accent);
  border: none;
  border-radius: 4px;
  padding: 0.4rem 0.9rem;
  font-size: 0.95rem;
  cursor: pointer;
}
.save-button:disabled {
  background: var(--color-border);
  color: var(--color-muted);
  cursor: not-allowed;
}
</style>
