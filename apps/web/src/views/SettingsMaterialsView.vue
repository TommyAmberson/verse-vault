<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, RouterLink } from 'vue-router'

import ScopeLevelSelector from '@/components/ScopeLevelSelector.vue'
import StatusChip from '@/components/StatusChip.vue'
import {
  type ChapterListScope,
  type CatchUp,
  type Club,
  type ClubMemorizeConfig,
  type ClubReviewConfig,
  type ClubStatus,
  type ClubTier,
  type MoveToNextGate,
  type PerClubYearSettings,
  type TierScope,
  type YearView,
  api,
} from '@/api'
import { invalidateSession } from '@/lib/engine/engineStore'
import { bulkPutRenders, clearRenders, newestRenderFetchedAt } from '@/lib/engine/persistence'

const SECS_PER_DAY = 86400

const CLUB_TIERS: ClubTier[] = ['150', '300', 'full']
const CLUBS: Club[] = ['club150', 'club300', 'full']

const TIER_LABELS: Record<ClubTier, string> = {
  '150': 'Club 150',
  '300': 'Club 300',
  full: 'Full',
}

const CLUB_LABELS: Record<Club, string> = {
  club150: 'Club 150',
  club300: 'Club 300',
  full: 'Full',
}

const CLUB_TO_TIER: Record<Club, ClubTier> = {
  club150: '150',
  club300: '300',
  full: 'full',
}

const STATUS_CHIP: Record<
  ClubStatus,
  { label: string; variant: 'accent' | 'warning' | 'muted' }
> = {
  active: { label: 'Active', variant: 'accent' },
  maintenance: { label: 'Maintenance', variant: 'warning' },
  paused: { label: 'Paused', variant: 'muted' },
}

const CHAPTER_LIST_LEVELS: { value: ChapterListScope; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'up150', label: '150' },
  { value: 'up300', label: '300' },
]

const TIER_SCOPE_LEVELS: { value: TierScope; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'up150', label: '150' },
  { value: 'up300', label: '300' },
  { value: 'all', label: 'Full' },
]

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

const CATCH_UP_OPTIONS: { value: CatchUp; label: string }[] = [
  { value: 'sequential', label: 'Sequential (next un-memorized verse)' },
  { value: 'calendarCascade', label: 'Calendar cascade (this week first, then backlog)' },
]

const GATE_OPTIONS: { value: MoveToNextGate; label: string }[] = [
  { value: 'fullyMemorized', label: 'Fully memorized' },
  { value: 'afterMajorCheckpoint', label: 'After major checkpoint (meet)' },
  { value: 'afterMinorCheckpoint', label: 'After minor checkpoint (this week)' },
  { value: 'caughtUp', label: 'Caught up to last week' },
  { value: 'always', label: 'Always (no gate)' },
]

/** Maps the gate position (between clubs[idx] and clubs[idx+1]) to the
 *  `moveToNext` field name. One entry per inter-club gap so the
 *  template can bind via `selected.draft.moveToNext[GATE_FIELDS[idx]]`
 *  instead of branching on `club === 'club150'`. */
const GATE_FIELDS = ['p150To300', 'p300ToFull'] as const

// Per-club retention range from the spec. Tighter than the legacy
// material-wide [0.7, 0.97] band so the slider exposes the meaningful
// region without trailing into asymptotic stability blow-ups.
const MIN_RETENTION_PCT = 50
const MAX_RETENTION_PCT = 90

interface YearCard {
  view: YearView
  /** Per-club draft, the source of truth for the form. Saving the card
   *  POSTs this verbatim via `updateYearSettingsPerClub`. */
  draft: PerClubYearSettings
  saving: boolean
  /** True while the toggle's flip-and-fetch (or flip-and-clear) is
   *  in flight. Drives the row's spinner state independent of the
   *  larger settings-form `saving` flag. */
  offlineBusy: boolean
  /** Unix-secs of the newest IDB render for this material, or 0 if
   *  none cached. Used to render "Last refreshed N days ago". */
  newestRenderAt: number
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

/** "Studying" iff enrolled AND any club is enabled for memorize OR
 *  review. Provisioned-but-everything-off years (e.g. the user touched
 *  the year once then disabled every club) read the same as
 *  never-touched: no enrolled marker, no card counts. */
function isStudying(c: YearCard): boolean {
  if (!c.view.enrolled) return false
  return CLUBS.some((k) => c.view.perClub.memorize[k].enabled || c.view.perClub.review[k].enabled)
}

/** Clone a per-club settings object for the editable draft. The shape
 *  is pure data (no functions, no cycles) so `structuredClone` is
 *  fully equivalent to a JSON round-trip and avoids the
 *  `{...x, memorize: {...x.memorize, club150: {...x.memorize.club150}}}`
 *  manual-spread stack every time a nested field is bound to v-model. */
function clonePerClub(p: PerClubYearSettings): PerClubYearSettings {
  return structuredClone(p)
}

async function refresh() {
  loading.value = true
  error.value = null
  try {
    const res = await api.getYears()
    const enriched = await Promise.all(
      res.years.map(async (view) => ({
        view,
        draft: clonePerClub(view.perClub),
        saving: false,
        offlineBusy: false,
        newestRenderAt: view.offlineMode ? await newestRenderFetchedAt(view.materialId) : 0,
      })),
    )
    cards.value = enriched
    // Re-resolve the active tab after the list changes. Prefer the year
    // the user is actively studying so the picker opens on a working
    // panel; otherwise fall back to any enrolled year, then to the first
    // listed.
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

/** True when the chain has a "memorize this club but don't review it"
 *  gap — the user is introducing verses that won't re-surface in
 *  /review. Almost always an oversight rather than intent. */
function memorizeBehindReview(draft: PerClubYearSettings): boolean {
  return CLUBS.some((k) => draft.memorize[k].enabled && !draft.review[k].enabled)
}

async function onSave(card: YearCard) {
  card.saving = true
  try {
    const wasOfflineMode = card.view.offlineMode
    await api.updateYearSettingsPerClub(card.view.materialId, card.draft)
    // Every per-club save can shift the MaterialConfig (enabled clubs,
    // catchUp choices, retention bands) — always drop the cached engine
    // and the render cache so the next session rebuilds. lessonBatchSize
    // alone doesn't move the engine, but the round-trip cost of a
    // diff-and-skip check isn't worth it vs. the one IDB clear.
    await invalidateSession(card.view.materialId)
    if (wasOfflineMode) await seedOfflineRenders(card.view.materialId)
    await refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    card.saving = false
  }
}

/** Deep-equality check between the active card's draft and its
 *  saved view.perClub — used to gate the Save button. As a computed
 *  it caches the serialise pair between mutations, so the user
 *  rapidly clicking through checkboxes doesn't fire two
 *  `JSON.stringify` passes per keystroke. JSON.stringify is sound
 *  here because both objects originate from the same construction
 *  path (server → `clonePerClub` → draft) so key order matches. */
const selectedIsDirty = computed<boolean>(() => {
  const c = selected.value
  if (!c) return false
  return JSON.stringify(c.draft) !== JSON.stringify(c.view.perClub)
})

function retentionPctFor(card: YearCard, club: Club): number {
  return Math.round(card.draft.review[club].desiredRetention * 100)
}

function onRetentionInput(card: YearCard, club: Club, event: Event) {
  const pct = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(pct)) return
  card.draft.review[club].desiredRetention = pct / 100
}

/** Clamp `lessonBatchSize` to a valid integer on every input change.
 *  `v-model.number` would happily yield `NaN` when the user clears the
 *  field or types a non-numeric character, and `JSON.stringify(NaN)` is
 *  `null` — which the API rejects with a 400. Holding the prior valid
 *  value while the input is in a transient invalid state keeps the
 *  Save button reliable. Out-of-range values clamp to `[1, 10]` to
 *  match the validator on the server. */
function onLessonBatchSizeInput(card: YearCard, event: Event) {
  const raw = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(raw)) return
  const clamped = Math.max(1, Math.min(10, Math.round(raw)))
  card.draft.lessonBatchSize = clamped
}

/** Memorized-verse progress per club, sourced from the engine-loaded
 *  card counts. The chain UI shows this next to each club's enable
 *  checkbox so the user can see how far along they are. */
function memorizedFor(card: YearCard, club: Club): number {
  return card.view.clubs[CLUB_TO_TIER[club]].cardCount
}

/** Status chip variant for the per-club card. Memorize-on (with or
 *  without review) reads as Active — the club is actively introducing
 *  verses, and the `memorizeBehindReview` warning calls out the
 *  memorize-without-review oversight separately so the status chip
 *  doesn't need a fourth state. Review-only reads as Maintenance,
 *  matching the legacy semantics. Neither enabled reads as Paused. */
function clubStatusFor(
  memorize: ClubMemorizeConfig,
  review: ClubReviewConfig,
): ClubStatus {
  if (memorize.enabled) return 'active'
  if (review.enabled) return 'maintenance'
  return 'paused'
}

function refreshedLabel(card: YearCard): string {
  if (card.newestRenderAt === 0) return 'Not yet downloaded.'
  const days = Math.floor((Date.now() / 1000 - card.newestRenderAt) / SECS_PER_DAY)
  if (days <= 0) return 'Refreshed today.'
  if (days === 1) return 'Refreshed 1 day ago.'
  return `Refreshed ${days} days ago.`
}

/** Fetch the bulk renders payload and seed IDB with it. Drops any
 *  composed=null rows the server emitted (chapter-fetch failures or
 *  unset BIBLE_API_KEY) so we don't shadow recovery for 30 days — the
 *  lazy `getRender` path applies the same filter and would refuse to
 *  cache them on the single-card route. */
async function seedOfflineRenders(materialId: string): Promise<void> {
  const { renders } = await api.getMaterialRenders(materialId)
  await bulkPutRenders(
    materialId,
    renders
      .filter((r) => r.composed !== null)
      .map((r) => {
        const { fetchedAt, ...cardRender } = r
        return { materialId, cardId: r.cardId, composed: cardRender, fetchedAt }
      }),
  )
}

async function onToggleOffline(card: YearCard) {
  if (card.offlineBusy) return
  const next = !card.view.offlineMode
  card.offlineBusy = true
  try {
    if (next) {
      // Flip the flag first so a partial failure mid-download still
      // leaves the user's intent on record (they can retry the
      // download from the toggle without re-flipping).
      await api.setOfflineMode(card.view.materialId, true)
      await seedOfflineRenders(card.view.materialId)
    } else {
      await clearRenders(card.view.materialId)
      await api.setOfflineMode(card.view.materialId, false)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    card.offlineBusy = false
    // Always re-sync from the server, even on failure, so the toggle
    // state reflects authoritative truth instead of stale local state.
    await refresh()
  }
}

onMounted(refresh)

/** Same nav-away guard pattern as ScheduleEditorView — the chain UI
 *  holds an editable draft, and the new "Edit schedule →" RouterLink
 *  in the per-material header is a one-click way to leave the route
 *  with unsaved per-club changes. Without this prompt the user's
 *  edits silently vanish on click. */
onBeforeRouteLeave((_to, _from, next) => {
  if (!selectedIsDirty.value) {
    next()
    return
  }
  const ok = window.confirm('You have unsaved settings. Leave without saving?')
  next(ok)
})
</script>

<template>
  <div class="materials">
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
            <RouterLink
              :to="`/schedule/${encodeURIComponent(selected.view.materialId)}`"
              class="schedule-link"
            >
              Edit schedule →
            </RouterLink>
          </div>
          <p class="year-description">{{ selected.view.description }}</p>
          <div class="tier-summary">
            <span v-for="tier in CLUB_TIERS" :key="tier" class="tier-pill">
              <span class="tier-pill-name">{{ TIER_LABELS[tier] }}</span>
              <span v-if="isStudying(selected)" class="tier-pill-count">
                {{ selected.view.clubs[tier].cardCount }}
              </span>
              <StatusChip :variant="STATUS_CHIP[selected.view.clubs[tier].status].variant">
                {{ STATUS_CHIP[selected.view.clubs[tier].status].label }}
              </StatusChip>
            </span>
          </div>
        </header>

        <section class="settings-section">
          <div class="section-title">What to memorize</div>
          <div class="chain">
            <template v-for="(club, idx) in CLUBS" :key="club">
              <article
                class="chain-card"
                :class="{ 'chain-card-disabled': !selected.draft.memorize[club].enabled }"
              >
                <header class="chain-card-header">
                  <label class="chain-enable">
                    <input
                      v-model="selected.draft.memorize[club].enabled"
                      type="checkbox"
                      :disabled="selected.saving"
                      :aria-label="`Enable memorize for ${CLUB_LABELS[club]}`"
                    />
                    <span class="chain-card-name">{{ CLUB_LABELS[club] }}</span>
                  </label>
                  <span class="chain-card-progress">
                    {{ memorizedFor(selected, club) }} cards
                  </span>
                </header>
                <label
                  v-if="selected.draft.memorize[club].enabled"
                  class="chain-knob"
                >
                  <span class="chain-knob-label">Catch-up</span>
                  <select
                    v-model="selected.draft.memorize[club].catchUp"
                    :disabled="selected.saving"
                  >
                    <option v-for="opt in CATCH_UP_OPTIONS" :key="opt.value" :value="opt.value">
                      {{ opt.label }}
                    </option>
                  </select>
                </label>
              </article>

              <!-- Gate row between clubs[idx] and clubs[idx+1]. Only
                   render when both flanking clubs are enabled — the
                   gate's irrelevant when either side is off. -->
              <div
                v-if="
                  idx < CLUBS.length - 1
                    && selected.draft.memorize[club].enabled
                    && selected.draft.memorize[CLUBS[idx + 1]].enabled
                "
                class="chain-gate"
              >
                <span class="chain-gate-label">
                  Move to {{ CLUB_LABELS[CLUBS[idx + 1]] }} when:
                </span>
                <select
                  v-model="selected.draft.moveToNext[GATE_FIELDS[idx]]"
                  :disabled="selected.saving"
                >
                  <option v-for="opt in GATE_OPTIONS" :key="opt.value" :value="opt.value">
                    {{ opt.label }}
                  </option>
                </select>
              </div>
            </template>
          </div>

          <div class="section-title section-title-spaced">What to review</div>
          <div class="chain">
            <article
              v-for="club in CLUBS"
              :key="club"
              class="chain-card"
              :class="{ 'chain-card-disabled': !selected.draft.review[club].enabled }"
            >
              <header class="chain-card-header">
                <label class="chain-enable">
                  <input
                    v-model="selected.draft.review[club].enabled"
                    type="checkbox"
                    :disabled="selected.saving"
                    :aria-label="`Enable review for ${CLUB_LABELS[club]}`"
                  />
                  <span class="chain-card-name">
                    {{ CLUB_LABELS[club] }}
                    <StatusChip
                      :variant="STATUS_CHIP[clubStatusFor(selected.draft.memorize[club], selected.draft.review[club])].variant"
                    >
                      {{ STATUS_CHIP[clubStatusFor(selected.draft.memorize[club], selected.draft.review[club])].label }}
                    </StatusChip>
                  </span>
                </label>
              </header>
              <label
                v-if="selected.draft.review[club].enabled"
                class="range-row"
              >
                <span class="range-label">
                  Target retention
                  <span class="range-value">{{ retentionPctFor(selected, club) }}%</span>
                </span>
                <input
                  :value="retentionPctFor(selected, club)"
                  type="range"
                  :min="MIN_RETENTION_PCT"
                  :max="MAX_RETENTION_PCT"
                  step="1"
                  :disabled="selected.saving"
                  @input="onRetentionInput(selected, club, $event)"
                />
              </label>
            </article>
          </div>
          <p v-if="memorizeBehindReview(selected.draft)" class="scope-warning" role="alert">
            One or more clubs are set to memorize but not review — newly-introduced verses won't re-surface in /review.
          </p>
          <p class="scope-fineprint">
            Higher target → more reviews + stronger recall. Lower → fewer reviews + more lapses.
            Range is {{ MIN_RETENTION_PCT }}–{{ MAX_RETENTION_PCT }}%.
          </p>

          <div class="section-title section-title-spaced">Card kinds</div>
          <div class="scope-stack">
            <label class="toggle">
              <input
                v-model="selected.draft.headingPassageCard"
                type="checkbox"
                :disabled="selected.saving"
              />
              <span>Heading passage prompts <span class="toggle-hint">— "what heading is this passage under?"</span></span>
            </label>
            <label class="toggle">
              <input
                v-model="selected.draft.headingCard"
                type="checkbox"
                :disabled="selected.saving"
              />
              <span>Per-verse heading prompts <span class="toggle-hint">— "which heading is this verse in?" (one card per verse)</span></span>
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

          <div class="section-title section-title-spaced">Offline study</div>
          <div class="scope-stack">
            <label class="toggle">
              <input
                type="checkbox"
                :checked="selected.view.offlineMode"
                :disabled="selected.offlineBusy || !selected.view.enrolled"
                @change="onToggleOffline(selected)"
              />
              <span>Make this year available offline</span>
            </label>
            <p class="scope-fineprint">
              Downloads ~5&nbsp;MB of pre-composed verse HTML so reviews work
              without a network. Refreshes every 30&nbsp;days from
              <a href="https://api.bible" target="_blank" rel="noopener">api.bible</a>
              per the cache policy.
            </p>
            <p v-if="selected.offlineBusy" class="scope-fineprint" aria-live="polite">
              {{ selected.view.offlineMode ? 'Clearing offline copy…' : 'Downloading offline copy…' }}
            </p>
            <p v-else-if="selected.view.offlineMode" class="scope-fineprint">
              {{ refreshedLabel(selected) }}
            </p>
          </div>

          <div class="section-title section-title-spaced">Session</div>
          <label class="number-row">
            <span>Verses per memorize session</span>
            <input
              :value="selected.draft.lessonBatchSize"
              type="number"
              min="1"
              max="10"
              :disabled="selected.saving"
              @input="onLessonBatchSizeInput(selected, $event)"
            />
          </label>

          <button
            type="button"
            class="save-button"
            :disabled="!selectedIsDirty || selected.saving"
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
.materials {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
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

/* Anchors the schedule-editor entry point. Sits next to the title so
   it's discoverable without burying the per-club chain UI below the
   fold. The card header already uses justify-content: space-between
   on the title row; the link rides the right edge there. */
.schedule-link {
  margin-left: auto;
  color: var(--color-accent);
  font-size: 0.85rem;
  text-decoration: none;
  white-space: nowrap;
}

.schedule-link:hover {
  text-decoration: underline;
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

.section-title {
  font-size: 0.78rem;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.section-title-spaced {
  margin-top: 0.75rem;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.chain {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.chain-card {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: 0.75rem 0.9rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.chain-card-disabled {
  opacity: 0.6;
}

.chain-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.chain-enable {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.95rem;
}

.chain-enable input[type='checkbox'] {
  accent-color: var(--color-accent);
}

.chain-card-name {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 500;
}

.chain-card-progress {
  color: var(--color-muted);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.chain-knob {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.chain-knob-label {
  font-size: 0.8rem;
  color: var(--color-muted);
}

.chain-knob select,
.chain-gate select {
  padding: 0.3rem 0.5rem;
  background: var(--color-bg-card);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.85rem;
}

.chain-gate {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-left: 1rem;
  padding: 0.4rem 0.75rem;
  border-left: 2px dashed var(--color-border);
}

.chain-gate-label {
  font-size: 0.8rem;
  color: var(--color-muted);
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

.toggle-hint {
  color: var(--color-muted);
  font-size: 0.85em;
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

.range-row {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.range-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  font-size: 0.85rem;
}

.range-value {
  color: var(--color-accent);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.range-row input[type='range'] {
  width: 100%;
  accent-color: var(--color-accent);
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
