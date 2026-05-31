<script setup lang="ts">
import type { ImportSummary } from '@/api'
import BaseModal from '@/components/BaseModal.vue'

defineProps<{
  /** The import summary on success, or null when `error` is set. */
  summary: ImportSummary | null
  /** A human-readable error message when the import failed. */
  error: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <BaseModal :title="error ? 'Import failed' : 'Import complete'" @dismiss="emit('close')">
    <p v-if="error" class="error">{{ error }}</p>
    <ul v-else-if="summary" class="summary">
      <li><span>Materials applied</span><strong>{{ summary.materialsApplied }}</strong></li>
      <li><span>Events imported</span><strong>{{ summary.eventsInserted }}</strong></li>
      <li><span>Events skipped (already present)</span><strong>{{ summary.eventsSkipped }}</strong></li>
      <li><span>Graduations applied</span><strong>{{ summary.graduationsApplied }}</strong></li>
      <li><span>Unresolved cards (dropped)</span><strong>{{ summary.unresolvedCardRefs }}</strong></li>
    </ul>
    <template #actions>
      <button type="button" class="btn confirm" @click="emit('close')">Done</button>
    </template>
  </BaseModal>
</template>

<style scoped>
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
</style>
