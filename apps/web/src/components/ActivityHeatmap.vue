<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ActivityDay } from '@/api'
import {
  ACADEMIC_YEAR_START_MONTH,
  type HeatmapCell,
  academicYearStart,
  buildGrid,
  isoDate,
  monthRuns,
} from '@/lib/heatmap'

const props = withDefaults(
  defineProps<{
    reviews: ActivityDay[]
    memorize: ActivityDay[]
    /** Side of each cell, in SVG user units. */
    cellSize?: number
    /** Gap between cells, in SVG user units. */
    gap?: number
  }>(),
  { cellSize: 11, gap: 2 },
)

const today = new Date()
const currentYearStart = academicYearStart(today)

type Series = 'reviews' | 'memorize'
const activeSeries = ref<Series>('reviews')
const yearStart = ref<Date>(currentYearStart)

const yearLabel = computed(() => {
  const startYear = yearStart.value.getUTCFullYear()
  return `${startYear}–20${String((startYear + 1) % 100).padStart(2, '0')}`
})

// Earliest data point across both series — defines how far back the
// picker can step. Uses lex string compare on ISO dates.
const earliestDate = computed(() => {
  let earliest: string | null = null
  for (const d of [...props.reviews, ...props.memorize]) {
    if (earliest === null || d.date < earliest) earliest = d.date
  }
  return earliest
})

const canStepBack = computed(() => {
  if (!earliestDate.value) return false
  return earliestDate.value < isoDate(yearStart.value)
})

const canStepForward = computed(
  () => yearStart.value.getTime() < currentYearStart.getTime(),
)

function stepBack() {
  if (!canStepBack.value) return
  yearStart.value = new Date(Date.UTC(
    yearStart.value.getUTCFullYear() - 1,
    ACADEMIC_YEAR_START_MONTH,
    1,
  ))
}

function stepForward() {
  if (!canStepForward.value) return
  yearStart.value = new Date(Date.UTC(
    yearStart.value.getUTCFullYear() + 1,
    ACADEMIC_YEAR_START_MONTH,
    1,
  ))
}

const activeData = computed(() =>
  activeSeries.value === 'reviews' ? props.reviews : props.memorize,
)

const grid = computed(() =>
  buildGrid(
    yearStart.value,
    today,
    new Map(activeData.value.map((d) => [d.date, d.count])),
  ),
)

const inWindowCells = computed(() => grid.value.filter((c) => c.inWindow))

const max = computed(() => inWindowCells.value.reduce((m, c) => Math.max(m, c.count), 0))
// Quartile-ish bucketing of [1..max] into four non-empty intensity levels.
const thresholds = computed(() => {
  if (max.value === 0) return [0, 0, 0]
  const m = max.value
  return [Math.ceil(m / 8), Math.ceil(m / 4), Math.ceil(m / 2)]
})

function level(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count === 0) return 0
  const [t1, t2, t3] = thresholds.value
  if (count <= (t1 ?? 0)) return 1
  if (count <= (t2 ?? 0)) return 2
  if (count <= (t3 ?? 0)) return 3
  return 4
}

const cellStride = computed(() => props.cellSize + props.gap)
const totalCols = computed(() =>
  grid.value.length === 0 ? 0 : (grid.value[grid.value.length - 1]?.col ?? 0) + 1,
)
const width = computed(() => totalCols.value * cellStride.value - props.gap)
const height = computed(() => 7 * cellStride.value - props.gap)

const totalCount = computed(() =>
  inWindowCells.value.reduce((s, c) => s + c.count, 0),
)
const activeDays = computed(() => inWindowCells.value.filter((c) => c.count > 0).length)

const streaks = computed(() => {
  const sorted = [...inWindowCells.value].sort((a, b) => a.date.localeCompare(b.date))
  let best = 0
  let run = 0
  for (const c of sorted) {
    if (c.count > 0) {
      run += 1
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  let current = 0
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if ((sorted[i]?.count ?? 0) === 0) break
    current += 1
  }
  return { current, best }
})

const isCurrentYear = computed(
  () => yearStart.value.getTime() === currentYearStart.getTime(),
)

const todayCount = computed<number | null>(() => {
  if (!isCurrentYear.value) return null
  const todayIso = isoDate(today)
  return activeData.value.find((d) => d.date === todayIso)?.count ?? 0
})

interface MonthLabel {
  text: string
  x: number
}

const monthLabels = computed<MonthLabel[]>(() =>
  monthRuns(grid.value).map((run) => ({
    text: new Date(run.sampleDate + 'T00:00:00Z').toLocaleString('en-CA', {
      month: 'short',
      timeZone: 'UTC',
    }),
    // +cellSize/2 anchors on the middle of the centre cell.
    x: ((run.startCol + run.endCol) / 2) * cellStride.value + props.cellSize / 2,
  })),
)

const dayLabels = [
  { text: 'S', row: 0 },
  { text: 'M', row: 1 },
  { text: 'T', row: 2 },
  { text: 'W', row: 3 },
  { text: 'T', row: 4 },
  { text: 'F', row: 5 },
  { text: 'S', row: 6 },
]

function cellTitle(c: HeatmapCell): string {
  const noun = activeSeries.value === 'reviews' ? 'review' : 'verse memorised'
  const plural = activeSeries.value === 'reviews' ? 'reviews' : 'verses memorised'
  if (c.count === 0) return `${c.date} — no activity`
  return `${c.date} — ${c.count} ${c.count === 1 ? noun : plural}`
}

const captionUnitSingular = computed(() => (activeSeries.value === 'reviews' ? 'review' : 'verse memorised'))
const captionUnitPlural = computed(() => (activeSeries.value === 'reviews' ? 'reviews' : 'verses memorised'))

function withUnit(n: number): string {
  return `${n.toLocaleString('en-CA')} ${n === 1 ? captionUnitSingular.value : captionUnitPlural.value}`
}

interface CaptionPart {
  label: string
  value: string
  emphasis?: boolean
}

const captionParts = computed<CaptionPart[]>(() => {
  const parts: CaptionPart[] = [
    { label: 'current streak', value: String(streaks.value.current), emphasis: true },
    { label: 'best streak', value: String(streaks.value.best) },
    { label: 'total days', value: String(activeDays.value) },
  ]
  if (todayCount.value !== null) {
    parts.push({ label: 'today', value: withUnit(todayCount.value) })
  }
  parts.push(
    { label: 'peak', value: withUnit(max.value) },
    { label: 'total', value: withUnit(totalCount.value) },
  )
  return parts
})
</script>

<template>
  <figure class="heatmap">
    <div class="heatmap-controls">
      <div class="series-toggle" role="tablist" aria-label="Activity series">
        <button
          type="button"
          role="tab"
          :aria-selected="activeSeries === 'reviews'"
          :class="{ active: activeSeries === 'reviews' }"
          @click="activeSeries = 'reviews'"
        >reviews</button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeSeries === 'memorize'"
          :class="{ active: activeSeries === 'memorize' }"
          @click="activeSeries = 'memorize'"
        >memorize</button>
      </div>
      <div class="year-picker">
        <button
          type="button"
          class="year-step"
          :disabled="!canStepBack"
          aria-label="Previous academic year"
          @click="stepBack"
        >‹</button>
        <span class="year-label">{{ yearLabel }}</span>
        <button
          type="button"
          class="year-step"
          :disabled="!canStepForward"
          aria-label="Next academic year"
          @click="stepForward"
        >›</button>
      </div>
    </div>
    <figcaption class="heatmap-caption">
      <template v-for="(part, i) in captionParts" :key="part.label">
        <span v-if="i > 0" class="heatmap-sep">·</span>
        <span :class="{ 'heatmap-emphasis': part.emphasis }">
          {{ part.label }} {{ part.value }}
        </span>
      </template>
    </figcaption>
    <svg
      class="heatmap-grid"
      :viewBox="`-16 -16 ${width + 16} ${height + 16}`"
      role="img"
      :aria-label="`${activeSeries} activity, ${yearLabel}`"
    >
      <text
        v-for="m in monthLabels"
        :key="`m-${m.x}`"
        class="month-label"
        :x="m.x"
        y="-4"
        text-anchor="middle"
      >{{ m.text }}</text>
      <text
        v-for="d in dayLabels"
        :key="`d-${d.row}`"
        class="day-label"
        x="-6"
        :y="d.row * cellStride + cellSize - 2"
        text-anchor="end"
      >{{ d.text }}</text>
      <!-- Out-of-window days hold the grid's shape but draw nothing, so
           only the in-window ones reach the DOM. -->
      <rect
        v-for="c in inWindowCells"
        :key="c.date"
        :class="['cell', `cell-l${level(c.count)}`, `series-${activeSeries}`]"
        :x="c.col * cellStride"
        :y="c.row * cellStride"
        :width="cellSize"
        :height="cellSize"
        rx="2"
        ry="2"
      >
        <title>{{ cellTitle(c) }}</title>
      </rect>
    </svg>
    <div class="heatmap-legend">
      <span class="legend-label">less</span>
      <span :class="['cell', 'cell-l0', 'legend-swatch', `series-${activeSeries}`]" />
      <span :class="['cell', 'cell-l1', 'legend-swatch', `series-${activeSeries}`]" />
      <span :class="['cell', 'cell-l2', 'legend-swatch', `series-${activeSeries}`]" />
      <span :class="['cell', 'cell-l3', 'legend-swatch', `series-${activeSeries}`]" />
      <span :class="['cell', 'cell-l4', 'legend-swatch', `series-${activeSeries}`]" />
      <span class="legend-label">more</span>
    </div>
  </figure>
</template>

<style scoped>
.heatmap {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.heatmap-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.series-toggle {
  display: inline-flex;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  overflow: hidden;
}

.series-toggle button {
  background: transparent;
  border: 0;
  padding: 0.3rem 0.7rem;
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 40;
  font-feature-settings: 'smcp', 'c2sc';
  letter-spacing: 0.16em;
  text-transform: uppercase;
  font-size: 0.7rem;
  color: var(--color-muted);
  cursor: pointer;
}

.series-toggle button.active {
  background: var(--color-bg-card);
  color: var(--color-text);
}

.year-picker {
  display: inline-flex;
  align-items: baseline;
  gap: 0.5rem;
  font-family: 'Fraunces', Georgia, serif;
}

.year-step {
  background: transparent;
  border: 0;
  padding: 0.1rem 0.4rem;
  color: var(--color-muted);
  font-size: 1.1rem;
  cursor: pointer;
  font-family: inherit;
}

.year-step:hover:not(:disabled) {
  color: var(--color-text);
}

.year-step:disabled {
  opacity: 0.3;
  cursor: default;
}

.year-label {
  font-variation-settings: 'opsz' 14, 'SOFT' 40;
  font-style: italic;
  font-size: 0.85rem;
  color: var(--color-text);
  letter-spacing: 0.02em;
  min-width: 4.5rem;
  text-align: center;
}

.heatmap-caption {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 50;
  font-style: italic;
  font-size: 0.85rem;
  color: var(--color-muted);
}

.heatmap-emphasis {
  font-style: normal;
  color: var(--color-text);
}

.heatmap-sep {
  margin: 0 0.4rem;
  opacity: 0.5;
}

.heatmap-grid {
  width: 100%;
  height: auto;
  overflow: visible;
}

.month-label,
.day-label {
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 40;
  font-feature-settings: 'smcp', 'c2sc';
  letter-spacing: 0.14em;
  font-size: 8px;
  fill: var(--color-muted);
}

/* Reviews → green; memorize → accent. Per-series `--series-fill` and
   `--series-soft` carry the palette, so the level rules below stay
   palette-agnostic and adding a third series later means one rule, not
   five times two. */
.series-reviews {
  --series-fill: var(--color-grade-good);
  --series-soft: var(--color-grade-good-bg);
}

.series-memorize {
  --series-fill: var(--color-accent);
  --series-soft: var(--color-accent-soft);
}

rect.cell {
  stroke: var(--color-border);
  stroke-width: 0.5;
}

rect.cell.cell-l0 { fill: var(--color-bg-card); }
rect.cell.cell-l1 { fill: var(--series-soft); }
rect.cell.cell-l2 { fill: var(--series-fill); opacity: 0.55; }
rect.cell.cell-l3 { fill: var(--series-fill); opacity: 0.8; }
rect.cell.cell-l4 { fill: var(--series-fill); }

.heatmap-legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.35rem;
  font-family: 'Fraunces', Georgia, serif;
  font-variation-settings: 'opsz' 14, 'SOFT' 40;
  font-style: italic;
  font-size: 0.78rem;
  color: var(--color-muted);
}

.legend-swatch {
  width: 11px;
  height: 11px;
  border-radius: 2px;
  border: 1px solid var(--color-border);
  display: inline-block;
}

.legend-swatch.cell-l0 { background: var(--color-bg-card); }
.legend-swatch.cell-l1 { background: var(--series-soft); }
.legend-swatch.cell-l2 { background: var(--series-fill); opacity: 0.55; }
.legend-swatch.cell-l3 { background: var(--series-fill); opacity: 0.8; }
.legend-swatch.cell-l4 { background: var(--series-fill); }
</style>
