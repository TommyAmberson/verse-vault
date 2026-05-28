<script setup lang="ts">
import { computed, ref } from 'vue'

import type { ActivityDay } from '@/api'

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

// Academic year runs Sep 1 → Aug 31; anchored on September to match the
// curriculum cadence.
const ACADEMIC_YEAR_START_MONTH = 8 // September (0-indexed)
const MS_PER_DAY = 86_400_000

function academicYearStart(date: Date): Date {
  const calYear = date.getUTCMonth() < ACADEMIC_YEAR_START_MONTH
    ? date.getUTCFullYear() - 1
    : date.getUTCFullYear()
  return new Date(Date.UTC(calYear, ACADEMIC_YEAR_START_MONTH, 1))
}

function academicYearEnd(start: Date): Date {
  // Inclusive Aug 31 of the calendar year after `start`.
  return new Date(Date.UTC(start.getUTCFullYear() + 1, ACADEMIC_YEAR_START_MONTH - 1, 31))
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setUTCDate(d.getUTCDate() + n)
  return out
}

const today = new Date()
const currentYearStart = academicYearStart(today)

type Series = 'reviews' | 'memorize'
const activeSeries = ref<Series>('reviews')
const yearStart = ref<Date>(currentYearStart)

const yearEnd = computed(() => academicYearEnd(yearStart.value))
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

interface Cell {
  date: string
  count: number
  row: number
  col: number
  month: number
  inWindow: boolean
}

// Cells outside the [yearStart, min(yearEnd, today)] window render blank
// so the grid's Sunday/Saturday edges align cleanly.
const grid = computed(() => {
  const startIso = isoDate(yearStart.value)
  const endDate = yearEnd.value.getTime() < today.getTime() ? yearEnd.value : today
  const endIso = isoDate(endDate)

  const byDate = new Map(activeData.value.map((d) => [d.date, d.count]))

  const leftAnchor = addDays(yearStart.value, -yearStart.value.getUTCDay())
  const rightAnchor = addDays(endDate, 6 - endDate.getUTCDay())

  const cells: Cell[] = []
  const totalDays = Math.round((rightAnchor.getTime() - leftAnchor.getTime()) / MS_PER_DAY) + 1
  for (let i = 0; i < totalDays; i += 1) {
    const cellDate = addDays(leftAnchor, i)
    const iso = isoDate(cellDate)
    const inWindow = iso >= startIso && iso <= endIso
    cells.push({
      date: iso,
      count: inWindow ? (byDate.get(iso) ?? 0) : 0,
      row: cellDate.getUTCDay(),
      col: Math.floor(i / 7),
      month: cellDate.getUTCMonth(),
      inWindow,
    })
  }
  return cells
})

const cellsByCol = computed(() => {
  const map = new Map<number, Cell[]>()
  for (const c of grid.value) {
    const arr = map.get(c.col)
    if (arr) arr.push(c)
    else map.set(c.col, [c])
  }
  return map
})

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

const monthLabels = computed<MonthLabel[]>(() => {
  // Per-column dominant month (the month that owns 4+ of its 7 days),
  // then collapse contiguous same-month runs and centre one label per
  // run. The dominant-month rule avoids the Aug-then-Sep collision at
  // the academic-year edge — column 0 of a Sep-anchored year contains
  // 1 Aug day + 6 Sep days, so Sep wins and Aug never gets a label
  // unless it owns a column of its own later.
  const colMonths: number[] = []
  for (let col = 0; col < totalCols.value; col += 1) {
    const colCells = cellsByCol.value.get(col)
    if (!colCells || colCells.length === 0) {
      colMonths.push(-1)
      continue
    }
    const monthCounts = new Map<number, number>()
    for (const c of colCells) {
      monthCounts.set(c.month, (monthCounts.get(c.month) ?? 0) + 1)
    }
    let dominantMonth = -1
    let dominantCount = 0
    for (const [m, count] of monthCounts) {
      if (count > dominantCount) {
        dominantMonth = m
        dominantCount = count
      }
    }
    colMonths.push(dominantMonth)
  }

  const out: MonthLabel[] = []
  let i = 0
  while (i < colMonths.length) {
    const m = colMonths[i]
    if (m === undefined || m === -1) {
      i += 1
      continue
    }
    let j = i
    while (j < colMonths.length && colMonths[j] === m) j += 1
    const runStart = i
    const runEnd = j - 1
    const sample = cellsByCol.value.get(runStart)?.find((c) => c.month === m)
    if (sample) {
      out.push({
        text: new Date(sample.date + 'T00:00:00Z').toLocaleString('en-CA', {
          month: 'short',
          timeZone: 'UTC',
        }),
        // +cellSize/2 anchors on the middle of the centre cell.
        x: ((runStart + runEnd) / 2) * cellStride.value + props.cellSize / 2,
      })
    }
    i = j
  }
  return out
})

const dayLabels = [
  { text: 'S', row: 0 },
  { text: 'M', row: 1 },
  { text: 'T', row: 2 },
  { text: 'W', row: 3 },
  { text: 'T', row: 4 },
  { text: 'F', row: 5 },
  { text: 'S', row: 6 },
]

function cellTitle(c: Cell): string {
  if (!c.inWindow) return ''
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
      <g v-for="c in grid" :key="`${c.col}-${c.row}-${c.date}`">
        <rect
          v-if="c.inWindow"
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
      </g>
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
