<script setup lang="ts">
import { onMounted, ref } from 'vue'

import {
  type ClubStatus,
  type ClubTier,
  type YearSettings,
  type YearView,
  api,
} from '@/api'

const CLUB_TIERS: ClubTier[] = ['150', '300']
const STATUSES: ClubStatus[] = ['active', 'maintenance', 'paused']

const STATUS_DESCRIPTIONS: Record<ClubStatus, string> = {
  active: 'Memorize new + review existing.',
  maintenance: 'Review only — no new verses introduced.',
  paused: 'Hidden from both queues; progress preserved.',
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
      savingClub: { '150': false, '300': false },
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
    draft.citation !== view.settings.citation ||
    draft.lessonBatchSize !== view.settings.lessonBatchSize
  )
}

function tierLabel(tier: ClubTier): string {
  return `Club ${tier}`
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
            <label class="toggle">
              <input
                v-model="card.draft.citation"
                type="checkbox"
                :disabled="card.savingSettings"
              />
              <span>Citation prompts (verse text → state the reference)</span>
            </label>
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
            <div class="club-control" :class="{ disabled: card.view.clubs[tier].cardCount === 0 }">
              <button
                v-for="opt in STATUSES"
                :key="opt"
                type="button"
                :class="['pill', `pill-${opt}`, { active: card.view.clubs[tier].status === opt }]"
                :disabled="card.view.clubs[tier].cardCount === 0 || card.savingClub[tier]"
                :title="STATUS_DESCRIPTIONS[opt]"
                @click="onChangeStatus(card, tier, opt)"
              >
                {{ opt }}
              </button>
            </div>
          </div>
          <p v-if="card.view.untaggedCardCount > 0" class="untagged-note">
            {{ card.view.untaggedCardCount }} additional cards aren't tagged to any
            club — they always surface regardless of these settings.
          </p>
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
  gap: 0.5rem;
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
  width: 4rem;
  padding: 0.25rem 0.5rem;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
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

.clubs {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.club-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 1rem;
}

.club-info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.club-name {
  font-weight: 500;
}

.club-count {
  font-size: 0.85rem;
  color: var(--color-muted);
}

.club-control {
  display: flex;
  gap: 0.25rem;
}

.club-control.disabled {
  opacity: 0.5;
}

.pill {
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-muted);
  padding: 0.2rem 0.7rem;
  border-radius: 999px;
  font-size: 0.85rem;
  text-transform: capitalize;
  cursor: pointer;
}

.pill:disabled {
  cursor: not-allowed;
}

.pill.active {
  color: var(--color-text);
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.untagged-note {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-muted);
}
</style>
