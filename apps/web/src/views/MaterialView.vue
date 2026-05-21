<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

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
import { invalidateSession } from '@/lib/engine/engineStore'

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
const selectedMaterialId = ref<string | null>(null)

const selected = computed<YearCard | null>(() => {
  const id = selectedMaterialId.value
  if (!id) return null
  return cards.value.find((c) => c.view.materialId === id) ?? null
})

/** A year reads as "studying" iff at least one of `newScope` or
 *  `reviewScope` is on. Provisioned-but-all-paused years (e.g. the
 *  user touched the year once then turned everything off) display the
 *  same as never-touched years: no enrolled marker, no card counts. */
function isStudying(c: YearCard): boolean {
  if (!c.view.enrolled) return false
  return c.view.settings.newScope !== 'off' || c.view.settings.reviewScope !== 'off'
}

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
    // Re-resolve the active tab after the list changes. Prefer the year
    // the user is actively studying (any scope above off) so the picker
    // opens on a working panel; otherwise fall back to any enrolled year,
    // and finally to the first listed.
    if (cards.value.length === 0) {
      selectedMaterialId.value = null
    } else if (!cards.value.some((c) => c.view.materialId === selectedMaterialId.value)) {
      const next =
        cards.value.find(isStudying) ?? cards.value.find((c) => c.view.enrolled) ?? cards.value[0]
      selectedMaterialId.value = next?.view.materialId ?? null
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

/** Strip the "(NKJV)" suffix some titles carry — saves horizontal space
 *  in the tab strip without losing meaning. */
function tabTitle(full: string): string {
  return full.replace(/\s*\(NKJV\)\s*$/, '')
}

const TIER_SCOPE_RANK: Record<TierScope, number> = {
  off: 0,
  up150: 1,
  up300: 2,
  all: 3,
}

/** True when Review's reach is narrower than New's — i.e. the user is
 *  memorising verses at a tier they don't review, so freshly-introduced
 *  verses won't re-surface. Worth surfacing because it's almost always
 *  an oversight rather than an intentional config. */
function reviewBehindNew(s: YearSettings): boolean {
  return TIER_SCOPE_RANK[s.reviewScope] < TIER_SCOPE_RANK[s.newScope]
}

async function onSave(card: YearCard) {
  card.saving = true
  try {
    await api.updateYearSettings(card.view.materialId, card.draft)
    // invalidateSession drops the cached engine AND the render cache,
    // so the next ReviewView/MemorizeView visit rebuilds with the new
    // MaterialConfig (and re-fetches renders that may reflect new card
    // visibility under the changed scope toggles).
    await invalidateSession(card.view.materialId)
    await refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    card.saving = false
  }
}

function settingsAreDirty(card: YearCard): boolean {
  return (Object.keys(card.draft) as Array<keyof YearSettings>).some(
    (k) => card.draft[k] !== card.view.settings[k],
  )
}

onMounted(refresh)
</script>

<template>
  <div class="material">
    <h2>Material</h2>
    <div v-if="error" class="banner banner-error">{{ error }}</div>
    <div v-if="loading" class="status">Loading…</div>
    <div v-else-if="cards.length === 0" class="status">
      No materials in the catalog.
    </div>
    <template v-else>
      <nav class="year-tabs" role="tablist" aria-label="Year">
        <button
          v-for="c in cards"
          :key="c.view.materialId"
          type="button"
          role="tab"
          :class="[
            'year-tab',
            {
              'tab-active': c.view.materialId === selectedMaterialId,
              'tab-unenrolled': !isStudying(c),
            },
          ]"
          :aria-selected="c.view.materialId === selectedMaterialId"
          :tabindex="c.view.materialId === selectedMaterialId ? 0 : -1"
          @click="selectedMaterialId = c.view.materialId"
        >
          <span class="tab-title">{{ tabTitle(c.view.title) }}</span>
          <span
            v-if="isStudying(c)"
            class="tab-marker tab-marker-enrolled"
            aria-hidden="true"
          />
        </button>
      </nav>
      <article
        v-if="selected"
        :key="selected.view.materialId"
        class="year-card"
        :class="{ 'year-card-unenrolled': !isStudying(selected) }"
      >
        <header class="year-header">
          <div class="year-title-row">
            <h3>{{ selected.view.title }}</h3>
            <span v-if="!isStudying(selected)" class="enrollment-badge">Not enrolled</span>
          </div>
          <p class="year-description">{{ selected.view.description }}</p>
          <div class="tier-summary">
            <span
              v-for="tier in CLUB_TIERS"
              :key="tier"
              class="tier-pill"
              :class="`tier-status-${selected.view.clubs[tier].status}`"
            >
              <span class="tier-pill-name">{{ TIER_LABELS[tier] }}</span>
              <span v-if="isStudying(selected)" class="tier-pill-count">
                {{ selected.view.clubs[tier].cardCount }}
              </span>
              <span :class="`status-chip status-${selected.view.clubs[tier].status}`">
                {{ STATUS_LABELS[selected.view.clubs[tier].status] }}
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
                v-model="selected.draft.newScope"
                :levels="TIER_SCOPE_LEVELS"
                :description="NEW_DESCRIPTIONS[selected.draft.newScope]"
                :disabled="selected.saving"
                aria-label="New verses scope"
              />
            </div>
            <div class="scope-row">
              <span class="scope-row-label">Review existing verses</span>
              <ScopeLevelSelector
                v-model="selected.draft.reviewScope"
                :levels="TIER_SCOPE_LEVELS"
                :description="REVIEW_DESCRIPTIONS[selected.draft.reviewScope]"
                :disabled="selected.saving"
                aria-label="Review scope"
              />
              <p v-if="reviewBehindNew(selected.draft)" class="scope-warning" role="alert">
                Review is narrower than New — verses you introduce above this level
                won't re-surface in /review.
              </p>
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
                v-model="selected.draft.headings"
                type="checkbox"
                :disabled="selected.saving"
              />
              <span>Headings</span>
            </label>
            <label class="toggle">
              <input
                v-model="selected.draft.ftv"
                type="checkbox"
                :disabled="selected.saving"
              />
              <span>FTV (finish-the-verse) prompts</span>
            </label>
            <div class="scope-row">
              <span class="scope-row-label">"Which club is this verse in?" prompts</span>
              <ScopeLevelSelector
                v-model="selected.draft.clubCardScope"
                :levels="TIER_SCOPE_LEVELS"
                :description="CLUB_CARD_DESCRIPTIONS[selected.draft.clubCardScope]"
                :disabled="selected.saving"
                aria-label="Per-verse club-card scope"
              />
            </div>
            <div class="scope-row">
              <span class="scope-row-label">Chapter-list prompts</span>
              <ScopeLevelSelector
                v-model="selected.draft.chapterListScope"
                :levels="CHAPTER_LIST_LEVELS"
                :description="CHAPTER_LIST_DESCRIPTIONS[selected.draft.chapterListScope]"
                :disabled="selected.saving"
                aria-label="Chapter-list scope"
              />
            </div>
          </div>

          <div class="section-title section-title-spaced">Session</div>
          <label class="number-row">
            <span>Verses per memorize session</span>
            <input
              v-model.number="selected.draft.lessonBatchSize"
              type="number"
              min="1"
              max="10"
              :disabled="selected.saving"
            />
          </label>

          <button
            type="button"
            class="save-button"
            :disabled="!settingsAreDirty(selected) || selected.saving"
            @click="onSave(selected)"
          >
            {{ selected.saving ? 'Saving…' : 'Save settings' }}
          </button>
        </section>
      </article>
    </template>
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

.year-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--color-border);
}

.year-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px 6px 0 0;
  padding: 0.4rem 0.85rem;
  margin-bottom: -1px; /* lap the bottom border for the "tab joins panel" look */
  color: var(--color-muted);
  font-family: inherit;
  font-size: 0.9rem;
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease,
    border-color 0.15s ease;
}

.year-tab:hover {
  color: var(--color-text);
}

.year-tab.tab-active {
  color: var(--color-text);
  background: var(--color-bg-card);
  border-color: var(--color-border);
  border-bottom-color: var(--color-bg-card);
  font-weight: 500;
}

.year-tab.tab-unenrolled .tab-title {
  font-style: italic;
}

.tab-marker {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
}

.tab-marker-enrolled {
  background: var(--color-accent);
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

.year-card-unenrolled {
  /* Subtle dimming so unenrolled years read as "available, not yet
     activated" without disappearing into the background. */
  border-style: dashed;
}

.year-header {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.year-title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}

.year-header h3 {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
}

.year-description {
  margin: 0;
  font-size: 0.85rem;
  color: var(--color-muted);
  line-height: 1.4;
}

.enrollment-badge {
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-muted);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
  white-space: nowrap;
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

.scope-warning {
  margin: 0;
  font-size: 0.82rem;
  color: var(--color-grade-hard);
  background: var(--color-grade-hard-bg);
  border-left: 3px solid var(--color-grade-hard);
  border-radius: 3px;
  padding: 0.35rem 0.6rem;
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
