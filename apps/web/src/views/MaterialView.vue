<script setup lang="ts">
import { onMounted, ref } from 'vue'

import ScopeLevelSelector from '@/components/ScopeLevelSelector.vue'
import {
  type ChapterListScope,
  type ClubCardScope,
  type ClubStatus,
  type ClubTier,
  type YearSettings,
  type YearView,
  api,
} from '@/api'

const CLUB_TIERS: ClubTier[] = ['150', '300', 'full']

// Status as a level track too: Paused → Maintenance → Active is a
// natural engagement ladder (each step adds capability — Maintenance
// reviews existing cards, Active also introduces new ones via /memorize).
const STATUS_LEVELS: { value: ClubStatus; label: string }[] = [
  { value: 'paused', label: 'Paused' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'active', label: 'Active' },
]

const STATUS_DESCRIPTIONS: Record<ClubStatus, string> = {
  active: 'Memorize new + review existing.',
  maintenance: 'Review only — no new verses introduced.',
  paused: 'Hidden from both queues; progress preserved.',
}

const TIER_LABELS: Record<ClubTier, string> = {
  '150': 'Club 150',
  '300': 'Club 300',
  full: 'Full',
}

// Track stops are ordered narrowest-on-the-right (Off ─ 150 ─ 300 ─ Full).
// Selecting a stop sets the scope to "everything up to here": clicking
// "300" includes Club 150 + Club 300 verses; clicking "Off" clears.
const CLUB_CARD_LEVELS: { value: ClubCardScope; label: string }[] = [
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

const CLUB_CARD_DESCRIPTIONS: Record<ClubCardScope, string> = {
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
  savingSettings: boolean
  savingClub: Record<ClubTier, boolean>
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
      savingSettings: false,
      savingClub: { '150': false, '300': false, full: false },
    }))
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function onSaveSettings(card: YearCard) {
  card.savingSettings = true
  try {
    await api.updateYearSettings(card.view.materialId, card.draft)
    await refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    card.savingSettings = false
  }
}

async function onChangeStatus(card: YearCard, tier: ClubTier, status: ClubStatus) {
  card.savingClub[tier] = true
  try {
    await api.updateClubStatus(card.view.materialId, tier, status)
    await refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    card.savingClub[tier] = false
  }
}

function settingsAreDirty(card: YearCard): boolean {
  const { draft, view } = card
  return (
    draft.headings !== view.settings.headings ||
    draft.ftv !== view.settings.ftv ||
    draft.clubCardScope !== view.settings.clubCardScope ||
    draft.chapterListScope !== view.settings.chapterListScope ||
    draft.lessonBatchSize !== view.settings.lessonBatchSize
  )
}

function tierLabel(tier: ClubTier): string {
  return TIER_LABELS[tier]
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
        </header>

        <section class="settings">
          <div class="section-title">Year settings</div>
          <div class="toggles">
            <label class="toggle">
              <input
                v-model="card.draft.headings"
                type="checkbox"
                :disabled="card.savingSettings"
              />
              <span>Headings</span>
            </label>
            <label class="toggle">
              <input
                v-model="card.draft.ftv"
                type="checkbox"
                :disabled="card.savingSettings"
              />
              <span>FTV (finish-the-verse) prompts</span>
            </label>
            <div class="scope-row">
              <span class="scope-row-label">"Which club is this verse in?" prompts</span>
              <ScopeLevelSelector
                v-model="card.draft.clubCardScope"
                :levels="CLUB_CARD_LEVELS"
                :description="CLUB_CARD_DESCRIPTIONS[card.draft.clubCardScope]"
                :disabled="card.savingSettings"
                aria-label="Per-verse club-card scope"
              />
            </div>
            <div class="scope-row">
              <span class="scope-row-label">Chapter-list prompts</span>
              <ScopeLevelSelector
                v-model="card.draft.chapterListScope"
                :levels="CHAPTER_LIST_LEVELS"
                :description="CHAPTER_LIST_DESCRIPTIONS[card.draft.chapterListScope]"
                :disabled="card.savingSettings"
                aria-label="Chapter-list scope"
              />
            </div>
            <label class="number-row">
              <span>Verses per memorize session</span>
              <input
                v-model.number="card.draft.lessonBatchSize"
                type="number"
                min="1"
                max="10"
                :disabled="card.savingSettings"
              />
            </label>
          </div>
          <button
            type="button"
            class="save-button"
            :disabled="!settingsAreDirty(card) || card.savingSettings"
            @click="onSaveSettings(card)"
          >
            {{ card.savingSettings ? 'Saving…' : 'Save settings' }}
          </button>
        </section>

        <section class="clubs">
          <div class="section-title">Clubs</div>
          <div v-for="tier in CLUB_TIERS" :key="tier" class="club-row">
            <div class="club-info">
              <div class="club-name">{{ tierLabel(tier) }}</div>
              <div class="club-count">{{ card.view.clubs[tier].cardCount }} cards</div>
            </div>
            <ScopeLevelSelector
              :model-value="card.view.clubs[tier].status"
              :levels="STATUS_LEVELS"
              :description="STATUS_DESCRIPTIONS[card.view.clubs[tier].status]"
              :disabled="
                card.view.clubs[tier].cardCount === 0 || card.savingClub[tier]
              "
              :aria-label="`${tierLabel(tier)} status`"
              @update:model-value="(s: ClubStatus) => onChangeStatus(card, tier, s)"
            />
          </div>
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

.year-header h3 {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
}

.section-title {
  font-size: 0.8rem;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.75rem;
}

.settings {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.toggles {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
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

.scope-row {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.scope-row-label {
  font-size: 0.95rem;
  color: var(--color-text);
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

.clubs {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.club-row {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.club-info {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}

.club-name {
  font-weight: 500;
}

.club-count {
  font-size: 0.85rem;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}
</style>
