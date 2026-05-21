<script setup lang="ts">
import { computed } from 'vue'

import type { StaleSummary } from '@/composables/useEngine'

const props = defineProps<{
  summary: StaleSummary
  /** Disables both action buttons while a confirm/discard call is in
   *  flight, so the user can't double-tap. */
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'discard'): void
  (e: 'cancel'): void
}>()

const oldestDate = computed(() =>
  new Date(props.summary.oldestQueuedTs * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }),
)
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="stale-title">
    <div class="modal">
      <h2 id="stale-title">Sync offline reviews from {{ oldestDate }}?</h2>
      <p>
        You have <strong>{{ summary.queuedCount }}</strong> offline
        review{{ summary.queuedCount === 1 ? '' : 's' }} queued from before
        <strong>{{ summary.serverEventsSince }}</strong> server-side
        review{{ summary.serverEventsSince === 1 ? '' : 's' }}. Merging will
        rebuild this deck's card history to include them. Discarding throws
        them away.
      </p>
      <div class="actions">
        <button
          type="button"
          class="btn discard"
          :disabled="busy"
          @click="emit('discard')"
        >
          Discard
        </button>
        <button
          type="button"
          class="btn cancel"
          :disabled="busy"
          @click="emit('cancel')"
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn sync"
          :disabled="busy"
          @click="emit('confirm')"
        >
          Sync
        </button>
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
  max-width: 480px;
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

.modal p {
  margin: 0;
  color: var(--color-muted);
  line-height: 1.5;
}

.actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-weight: 500;
  font-size: 0.95rem;
  border: 1px solid transparent;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.discard {
  background: var(--color-grade-again-bg);
  color: var(--color-grade-again);
}

.cancel {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-muted);
}

.sync {
  background: var(--color-accent);
  color: var(--color-on-accent);
}
</style>
