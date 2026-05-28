<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { type ActivityDay, type ActivityResponse, type StatsResponse, api } from '@/api'
import ActivityHeatmap from '@/components/ActivityHeatmap.vue'

interface YearAgg {
  materialId: string
  title: string
  newCardCount: number
  stats: StatsResponse
}

const years = ref<YearAgg[]>([])
const partialFailed = ref(0)
const error = ref<string | null>(null)
const loading = ref(true)
const mounted = ref(false)
const activityReviews = ref<ActivityDay[]>([])
const activityMemorize = ref<ActivityDay[]>([])

function sumOver(pick: (y: YearAgg) => number) {
  return computed(() => years.value.reduce((sum, y) => sum + pick(y), 0))
}

const totalNewToMemorize = sumOver((y) => y.newCardCount)
const totalNewVerses = sumOver((y) => y.stats.newVerseCount)
const totalVersesDue = sumOver((y) => y.stats.versesDueCount)
const totalVersesHeld = sumOver((y) => y.stats.versesLearned)
const totalReviewsDue = sumOver((y) => y.stats.reviewsDueCount)
const totalReviews = sumOver((y) => y.stats.totalGrades)

const aggregateRetention = computed<number | null>(() => {
  let passes = 0
  let grades = 0
  for (const y of years.value) {
    const r = y.stats.retentionRate
    if (r === null) continue
    passes += r * y.stats.totalGrades
    grades += y.stats.totalGrades
  }
  if (grades === 0) return null
  return passes / grades
})

const BUCKETS = ['weak', 'learning', 'familiar', 'strong', 'mastered'] as const
type Bucket = (typeof BUCKETS)[number]

function sumDistributions(
  pick: (s: StatsResponse) => Record<Bucket, number>,
): Record<Bucket, number> {
  const out: Record<Bucket, number> = {
    weak: 0,
    learning: 0,
    familiar: 0,
    strong: 0,
    mastered: 0,
  }
  for (const y of years.value) {
    const d = pick(y.stats)
    for (const b of BUCKETS) out[b] += d[b]
  }
  return out
}

const stages = computed(() => {
  const cards = sumDistributions((s) => s.cardDistribution)
  const verses = sumDistributions((s) => s.verseDistribution)
  return BUCKETS.map((bucket) => ({
    bucket,
    cards: cards[bucket],
    verses: verses[bucket],
  }))
})

const stagesShown = computed(() => stages.value.some((s) => s.cards > 0 || s.verses > 0))

const empty = computed(
  () => !loading.value && years.value.length === 0 && !error.value,
)

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

onMounted(async () => {
  try {
    const emptyActivity: ActivityResponse = { reviews: [], memorize: [], requestedDays: 1825 }
    const [yearsRes, activityRes] = await Promise.all([
      api.getYears(),
      api.getActivity(1825).catch(() => emptyActivity),
    ])
    activityReviews.value = activityRes.reviews
    activityMemorize.value = activityRes.memorize
    const enrolled = yearsRes.years.filter((y) => y.enrolled)

    const settled = await Promise.allSettled(
      enrolled.map(async (y): Promise<YearAgg> => ({
        materialId: y.materialId,
        title: y.title,
        newCardCount: y.newCardCount,
        stats: await api.getStats(y.materialId),
      })),
    )
    const succeeded: YearAgg[] = []
    let failed = 0
    for (const r of settled) {
      if (r.status === 'fulfilled') succeeded.push(r.value)
      else failed += 1
    }
    // Lead with the most-worked year — most likely the focus.
    succeeded.sort((a, b) => b.stats.totalGrades - a.stats.totalGrades)
    years.value = succeeded
    partialFailed.value = failed
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
    // Defer one frame so the staggered reveal transitions actually
    // play — same-tick flips collapse into one paint.
    requestAnimationFrame(() => {
      mounted.value = true
    })
  }
})
</script>

<template>
  <article class="codex" :class="{ revealed: mounted }">
    <p v-if="error" class="page-banner page-banner-error">{{ error }}</p>
    <p v-else-if="loading" class="page-banner page-banner-quiet">
      <em>reading the codex…</em>
    </p>
    <template v-else-if="empty">
      <section class="empty">
        <p class="empty-line"><em>This codex is empty.</em></p>
        <RouterLink to="/material" class="empty-cta">
          Choose your first year
          <span aria-hidden="true">↗</span>
        </RouterLink>
      </section>
    </template>
    <template v-else>
      <p v-if="partialFailed > 0" class="page-banner page-banner-warning">
        {{ partialFailed }} year{{ partialFailed === 1 ? '' : 's' }} couldn't be
        loaded. Refresh to retry.
      </p>

      <section class="hero">
        <RouterLink
          to="/memorize"
          class="hero-panel hero-panel-action"
          :class="{ idle: totalNewToMemorize === 0 }"
        >
          <p class="hero-label">to memorize</p>
          <p class="hero-numeral">
            <span class="numeral">{{ totalNewToMemorize }}</span>
          </p>
          <p class="hero-sub">
            <template v-if="totalNewToMemorize === 0">
              caught up — nothing new is waiting.
            </template>
            <template v-else>
              fresh card{{ totalNewToMemorize === 1 ? '' : 's' }}
              from {{ totalNewVerses }} verse{{ totalNewVerses === 1 ? '' : 's' }}<template
                v-if="years.length > 1"
              > across {{ years.length }} years</template>.
            </template>
          </p>
          <p class="hero-arrow">
            <span>memorize</span>
            <span class="hero-arrow-glyph" aria-hidden="true">→</span>
          </p>
        </RouterLink>

        <RouterLink
          to="/review"
          class="hero-panel hero-panel-review"
          :class="{ idle: totalReviewsDue === 0 }"
        >
          <p class="hero-label">to review</p>
          <p class="hero-numeral">
            <span class="numeral">{{ totalReviewsDue }}</span>
          </p>
          <p class="hero-sub">
            <template v-if="totalVersesHeld === 0 && totalReviewsDue === 0">
              none yet — every codex begins blank.
            </template>
            <template v-else-if="totalReviewsDue === 0">
              all caught up — nothing due right now.
            </template>
            <template v-else>
              card{{ totalReviewsDue === 1 ? '' : 's' }} due now
              from {{ totalVersesDue }} verse{{ totalVersesDue === 1 ? '' : 's' }}<template
                v-if="years.length > 1"
              > across {{ years.length }} years</template>.
            </template>
          </p>
          <p class="hero-arrow">
            <span>review</span>
            <span class="hero-arrow-glyph" aria-hidden="true">→</span>
          </p>
        </RouterLink>
      </section>

      <section v-if="stagesShown" class="stages-section">
        <h2 class="rule-heading"><span>stability</span></h2>
        <ol class="stages">
          <li
            v-for="(stage, i) in stages"
            :key="stage.bucket"
            :class="[
              'stage',
              `seg-${stage.bucket}`,
              { 'stage-idle': stage.cards === 0 && stage.verses === 0 },
            ]"
            :style="{ transitionDelay: `${280 + i * 80}ms` }"
          >
            <span class="stage-stripe" aria-hidden="true" />
            <span class="stage-label">{{ stage.bucket }}</span>
            <p class="stage-stat">
              <span class="stage-stat-value">{{ stage.cards }}</span>
              <span class="stage-stat-unit">card{{ stage.cards === 1 ? '' : 's' }}</span>
            </p>
            <p class="stage-stat stage-stat-secondary">
              <span class="stage-stat-value">{{ stage.verses }}</span>
              <span class="stage-stat-unit">verse{{ stage.verses === 1 ? '' : 's' }}</span>
            </p>
          </li>
        </ol>
      </section>

      <section
        v-if="activityReviews.length > 0 || activityMemorize.length > 0"
        class="activity-section"
      >
        <h2 class="rule-heading"><span>activity</span></h2>
        <ActivityHeatmap :reviews="activityReviews" :memorize="activityMemorize" />
      </section>

      <RouterLink class="rule-heading rule-heading-link" to="/stats">
        <span>by year →</span>
      </RouterLink>

      <p v-if="totalReviews > 0" class="ledger">
        <em>
          <template v-if="aggregateRetention !== null">{{ pct(aggregateRetention) }}
            retention · </template>{{ totalReviews.toLocaleString('en-CA') }}
          review{{ totalReviews === 1 ? '' : 's' }} logged ·
          {{ totalVersesHeld }} verse{{ totalVersesHeld === 1 ? '' : 's' }} held
        </em>
      </p>
    </template>
  </article>
</template>

<style scoped>
/* Fraunces handles display work (headings, oversized numerals,
   section rules); body copy inherits the app's system stack. */

.codex {
  width: 100%;
  max-width: 880px;
  display: flex;
  flex-direction: column;
  gap: 2.75rem;
  color: var(--color-text);
  position: relative;
  /* Faint paper-grain noise overlay. Inlined SVG so there is no
     extra request and no flash before the texture lands. */
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.045 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
  background-blend-mode: multiply;
}

.codex > * {
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 600ms cubic-bezier(0.2, 0.7, 0.2, 1),
    transform 600ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

.codex.revealed > * {
  opacity: 1;
  transform: translateY(0);
}

.codex > *:nth-child(1) { transition-delay: 0ms; }
.codex > *:nth-child(2) { transition-delay: 80ms; }
.codex > *:nth-child(3) { transition-delay: 160ms; }
.codex > *:nth-child(4) { transition-delay: 240ms; }

/* ── Banners ──────────────────────────────────────────────── */

.page-banner {
  padding: 0.75rem 1rem;
  border-left: 2px solid var(--color-muted);
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 50;
  font-size: 0.95rem;
}

.page-banner-quiet {
  color: var(--color-muted);
  border-color: transparent;
  padding-left: 0;
}

.page-banner-error {
  border-color: var(--color-error);
  color: var(--color-error);
  background: var(--color-error-bg);
}

.page-banner-warning {
  border-color: var(--color-grade-hard);
  color: var(--color-grade-hard);
  background: var(--color-grade-hard-bg);
}

/* ── Hero panels ──────────────────────────────────────────── */

.hero {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.5rem;
}

.hero-panel {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 2px;
  padding: 1.5rem 1.75rem 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  position: relative;
  text-decoration: none;
  color: var(--color-text);
  cursor: pointer;
  box-shadow: inset 0 0 0 1px transparent;
  transition:
    border-color 200ms ease,
    box-shadow 200ms ease,
    transform 200ms ease;
}

.hero-panel-action:not(.idle) {
  box-shadow: inset 0 0 0 1px var(--color-accent-soft);
}

.hero-panel-review:not(.idle) {
  box-shadow: inset 0 0 0 1px var(--color-border);
}

.hero-panel:hover {
  border-color: var(--color-text);
  transform: translateY(-2px);
}

.hero-panel:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 3px;
}

.hero-label {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 30, 'WONK' 0;
  font-feature-settings: 'smcp', 'c2sc';
  letter-spacing: 0.2em;
  text-transform: uppercase;
  font-size: 0.7rem;
  color: var(--color-muted);
  margin: 0;
}

.hero-numeral {
  margin: 0;
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 144, 'wght' 360, 'SOFT' 100, 'WONK' 1;
  font-size: clamp(4rem, 9vw, 6rem);
  line-height: 0.95;
  font-feature-settings: 'lnum', 'tnum';
  letter-spacing: -0.02em;
}

.hero-panel-action:not(.idle) .numeral {
  color: var(--color-accent);
}

.hero-panel-review:not(.idle) .numeral {
  color: var(--color-text);
}

.hero-sub {
  margin: 0;
  font-size: 0.95rem;
  color: var(--color-muted);
  line-height: 1.5;
  font-style: italic;
  max-width: 28ch;
}

.hero-arrow {
  margin: auto 0 0;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border);
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 30;
  font-feature-settings: 'smcp', 'c2sc';
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-size: 0.78rem;
  color: var(--color-accent);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.hero-panel.idle .hero-arrow {
  color: var(--color-muted);
}

.hero-arrow-glyph {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 48, 'SOFT' 60;
  font-feature-settings: normal;
  letter-spacing: 0;
  text-transform: none;
  font-size: 1.25rem;
  transition: transform 200ms ease;
}

.hero-panel:hover .hero-arrow-glyph {
  transform: translateX(4px);
}

/* ── Section rules ───────────────────────────────────────── */

.rule-heading {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 30, 'WONK' 0;
  font-feature-settings: 'smcp', 'c2sc';
  font-weight: 400;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  font-size: 0.72rem;
  color: var(--color-muted);
  display: flex;
  align-items: center;
  gap: 1rem;
  margin: 0 0 1rem;
}

.rule-heading::before,
.rule-heading::after {
  content: '';
  height: 1px;
  background: var(--color-border);
  flex: 1;
}

.rule-heading span {
  flex: 0 0 auto;
}

/* ── SRS-stage tiles ─────────────────────────────────────── */

.stages {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
  gap: 0.75rem;
  align-items: start;
}

.stage {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 2px;
  padding: 3.5rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  align-items: center;
  text-align: center;
  position: relative;
  overflow: hidden;
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 600ms cubic-bezier(0.2, 0.7, 0.2, 1),
    transform 600ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

.codex.revealed .stage {
  opacity: 1;
  transform: translateY(0);
}

/* Idle (zero-count) tiles dim so the lit ones lead the eye.
   Modifier is `stage-idle`, not `empty`, because the dashboard's
   no-enrollments `.empty` rule below would otherwise cascade onto
   these tiles by accident. */
.codex.revealed .stage-idle {
  opacity: 0.4;
}

.stage-stripe {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
}

.stage.seg-weak .stage-stripe { background: var(--color-grade-again); }
.stage.seg-learning .stage-stripe { background: var(--color-grade-hard); }
.stage.seg-familiar .stage-stripe { background: var(--color-grade-good); }
.stage.seg-strong .stage-stripe { background: var(--color-accent); }
.stage.seg-mastered .stage-stripe { background: var(--color-grade-easy); }

.stage-label {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 40;
  font-feature-settings: 'smcp', 'c2sc';
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-size: 0.65rem;
  color: var(--color-muted);
  margin-top: 0.15rem;
  margin-bottom: 0.15rem;
}

.stage-stat {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 0.35rem;
  margin: 0;
}

.stage-stat-value {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 72, 'wght' 400, 'SOFT' 65, 'WONK' 0;
  font-feature-settings: 'lnum', 'tnum';
  font-size: 1.4rem;
  line-height: 1;
}

.stage-stat-unit {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 50;
  font-style: italic;
  font-size: 0.75rem;
  color: var(--color-muted);
}

.stage-stat-secondary .stage-stat-value {
  font-variation-settings: 'opsz' 36, 'wght' 380, 'SOFT' 55;
  font-size: 0.95rem;
  color: var(--color-muted);
}

/* ── "by year →" link ─────────────────────────────────────── */

/* Reuses the `.rule-heading` chrome (centred small-caps with hairlines
   on either side); `-link` strips the link defaults so it reads as
   a section title that happens to be clickable. */
.rule-heading-link {
  text-decoration: none;
  color: var(--color-muted);
  transition: color 200ms ease;
}

.rule-heading-link:hover {
  color: var(--color-accent);
}

/* ── Empty state ─────────────────────────────────────────── */

.empty {
  padding: 4rem 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  align-items: center;
}

.empty-line {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 96, 'wght' 360, 'SOFT' 80, 'WONK' 1;
  font-size: clamp(1.6rem, 3.5vw, 2.2rem);
  color: var(--color-muted);
  margin: 0;
}

.empty-cta {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 30;
  font-feature-settings: 'smcp', 'c2sc';
  letter-spacing: 0.2em;
  text-transform: uppercase;
  font-size: 0.8rem;
  color: var(--color-accent);
  text-decoration: none;
  border-bottom: 1px solid var(--color-accent);
  padding-bottom: 0.2rem;
}

.empty-cta:hover {
  color: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
}

/* ── Ledger footnote ─────────────────────────────────────── */

.ledger {
  margin: 0;
  padding-top: 0.5rem;
  text-align: center;
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 50;
  font-style: italic;
  font-size: 0.88rem;
  color: var(--color-muted);
  letter-spacing: 0.02em;
}

/* ── Reduced motion ──────────────────────────────────────── */

@media (prefers-reduced-motion: reduce) {
  .codex > *,
  .stage {
    transition: none;
  }
}
</style>
