<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { MATERIAL_ID, type StatsResponse, api } from '@/api'

const stats = ref<StatsResponse | null>(null)
const error = ref<string | null>(null)
const loading = ref(true)

const buckets = computed(() => {
  if (!stats.value) return []
  const dist = stats.value.testDistribution
  const total = Object.values(dist).reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const labels: Array<keyof typeof dist> = ['weak', 'learning', 'familiar', 'strong', 'mastered']
  return labels.map((label) => ({
    label,
    count: dist[label],
    percent: (dist[label] / total) * 100,
  }))
})

const retentionPct = computed(() =>
  stats.value && stats.value.retentionRate !== null
    ? `${(stats.value.retentionRate * 100).toFixed(0)}%`
    : '—',
)

onMounted(async () => {
  try {
    stats.value = await api.getStats(MATERIAL_ID)
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
    <div v-else-if="stats" class="content">
      <h2>Stats</h2>

      <div class="grid">
        <div class="metric">
          <div class="metric-label">Verses learned</div>
          <div class="metric-value">{{ stats.versesLearned }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Retention</div>
          <div class="metric-value">{{ retentionPct }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Total reviews</div>
          <div class="metric-value">{{ stats.totalGrades }}</div>
        </div>
      </div>

      <div class="histogram">
        <div class="histogram-title">Test stability</div>
        <div v-for="b in buckets" :key="b.label" class="bar-row">
          <div class="bar-label">{{ b.label }}</div>
          <div class="bar-track">
            <div :class="['bar', `bar-${b.label}`]" :style="{ width: `${b.percent}%` }" />
          </div>
          <div class="bar-count">{{ b.count }}</div>
        </div>
      </div>
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
