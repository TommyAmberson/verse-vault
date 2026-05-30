<script setup lang="ts">
import { useId } from 'vue'

import type { ImportSummary } from '@/api'

defineProps<{
  /** The import summary on success, or null when `error` is set. */
  summary: ImportSummary | null
  /** A human-readable error message when the import failed. */
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const titleId = useId()
</script>

<template>
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    @click.self="emit('close')"
  >
    <div class="modal">
      <h2 :id="titleId">{{ error ? 'Import failed' : 'Import complete' }}</h2>
      <div class="body">
        <p v-if="error" class="error">{{ error }}</p>
        <ul v-else-if="summary" class="summary">
          <li><span>Materials applied</span><strong>{{ summary.materialsApplied }}</strong></li>
          <li><span>Events imported</span><strong>{{ summary.eventsInserted }}</strong></li>
          <li><span>Events skipped (already present)</span><strong>{{ summary.eventsSkipped }}</strong></li>
          <li><span>Graduations applied</span><strong>{{ summary.graduationsApplied }}</strong></li>
          <li><span>Unresolved cards (dropped)</span><strong>{{ summary.unresolvedCardRefs }}</strong></li>
        </ul>
      </div>
      <div class="actions">
        <button type="button" class="btn confirm" @click="emit('close')">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1rem;
}

.modal {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  max-width: 440px;
  width: 100%;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.modal h2 {
  font-size: 1.1rem;
  margin: 0;
}

.body {
  color: var(--color-muted);
  line-height: 1.5;
}

.error {
  margin: 0;
  color: var(--color-grade-again);
}

.summary {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.summary li {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.summary strong {
  color: var(--color-text);
}

.actions {
  display: flex;
  justify-content: flex-end;
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-weight: 500;
  font-size: 0.95rem;
  border: 1px solid transparent;
  font-family: inherit;
  cursor: pointer;
}

.confirm {
  background: var(--color-accent);
  color: var(--color-on-accent);
}
</style>
