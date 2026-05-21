<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { type StatsResponse, api } from '@/api'

interface YearStats {
  materialId: string
  title: string
  stats: StatsResponse
}

const years = ref<YearStats[]>([])
const error = ref<string | null>(null)
const partial = ref<{ failed: number } | null>(null)
const loading = ref(true)

const DIST_LABELS = ['weak', 'learning', 'familiar', 'strong', 'mastered'] as const

function bucketsFor(stats: StatsResponse) {
  const dist = stats.testDistribution
  const total = Object.values(dist).reduce((a, b) => a + b, 0)
  if (total === 0) return []
  return DIST_LABELS.map((label) => ({
    label,
    count: dist[label],
    percent: (dist[label] / total) * 100,
  }))
}

function retentionPct(stats: StatsResponse) {
  return stats.retentionRate !== null ? `${(stats.retentionRate * 100).toFixed(0)}%` : '—'
}

const empty = computed(() => !loading.value && years.value.length === 0 && !error.value)

onMounted(async () => {
  try {
    // Stats are per-year. Show every year the user is enrolled in; sort by
    // total reviews so the most-worked year leads.
    const yearsRes = await api.getYears()
    const enrolled = yearsRes.years.filter((y) => y.enrolled)
    // allSettled so one bad year (stale enrollment 404, transient 5xx)
    // doesn't blank the entire page — surface a small "N years failed
    // to load" note alongside the successful ones instead.
    const settled = await Promise.allSettled(
      enrolled.map(async (y): Promise<YearStats> => ({
        materialId: y.materialId,
        title: y.title,
        stats: await api.getStats(y.materialId),
      })),
    )
    const succeeded: YearStats[] = []
    let failed = 0
    for (const r of settled) {
      if (r.status === 'fulfilled') succeeded.push(r.value)
      else failed += 1
    }
    succeeded.sort((a, b) => b.stats.totalGrades - a.stats.totalGrades)
    years.value = succeeded
    if (failed > 0) partial.value = { failed }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="stats">
    <div v-if="error" class="banner banner-error">{{ error }}</div>
    <div v-else-if="loading" class="status">Loading…</div>
    <div v-else-if="empty" class="status">
      No enrolled years yet. Pick one in
      <RouterLink to="/material">/material</RouterLink> to start.
    </div>
    <div v-else class="content">
      <h2>Stats</h2>
      <div v-if="partial" class="banner banner-warning">
        {{ partial.failed }} year{{ partial.failed === 1 ? '' : 's' }} couldn't
        be loaded. Refresh to retry.
      </div>
      <section v-for="y in years" :key="y.materialId" class="year-stats">
        <h3>{{ y.title }}</h3>
        <div class="grid">
          <div class="metric">
            <div class="metric-label">Verses learned</div>
            <div class="metric-value">{{ y.stats.versesLearned }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">Retention</div>
            <div class="metric-value">{{ retentionPct(y.stats) }}</div>
          </div>
          <div class="metric">
            <div class="metric-label">Total reviews</div>
            <div class="metric-value">{{ y.stats.totalGrades }}</div>
          </div>
        </div>

        <div v-if="bucketsFor(y.stats).length > 0" class="histogram">
          <div class="histogram-title">Test stability</div>
          <div v-for="b in bucketsFor(y.stats)" :key="b.label" class="bar-row">
            <div class="bar-label">{{ b.label }}</div>
            <div class="bar-track">
              <div :class="['bar', `bar-${b.label}`]" :style="{ width: `${b.percent}%` }" />
            </div>
            <div class="bar-count">{{ b.count }}</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.stats {
  width: 100%;
  max-width: 640px;
}

.status {
  padding: 2rem;
  text-align: center;
  color: var(--color-muted);
}

.banner {
  padding: 0.75rem 1rem;
  border-radius: 6px;
  font-size: 0.95rem;
}

.banner-error {
  background: var(--color-error-bg);
  color: var(--color-error);
}

.banner-warning {
  background: var(--color-grade-hard-bg);
  color: var(--color-grade-hard);
}

.content {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

h2 {
  font-size: 1.5rem;
  margin: 0;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.75rem;
}

.metric {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 1rem;
}

.metric-label {
  font-size: 0.85rem;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.metric-value {
  font-size: 1.75rem;
  font-weight: 500;
  margin-top: 0.25rem;
}

.year-stats {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.year-stats h3 {
  font-size: 1.1rem;
  margin: 0;
}

.histogram {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.histogram-title {
  font-size: 0.85rem;
  color: var(--color-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.5rem;
}

.bar-row {
  display: grid;
  grid-template-columns: 6rem 1fr 3rem;
  align-items: center;
  gap: 0.75rem;
}

.bar-label {
  font-size: 0.9rem;
  color: var(--color-muted);
  text-transform: capitalize;
}

.bar-track {
  height: 0.75rem;
  background: var(--color-bg);
  border-radius: 4px;
  overflow: hidden;
}

.bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.2s;
}

.bar-weak { background: var(--color-grade-again); }
.bar-learning { background: var(--color-grade-hard); }
.bar-familiar { background: var(--color-grade-good); }
.bar-strong { background: var(--color-accent); }
.bar-mastered { background: var(--color-grade-easy); }

.bar-count {
  text-align: right;
  font-size: 0.9rem;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}
</style>
