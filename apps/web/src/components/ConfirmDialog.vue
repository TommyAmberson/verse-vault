<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{
    title: string
    confirmLabel?: string
    cancelLabel?: string
    /** Colours the confirm button red. Use for delete-type prompts. */
    destructive?: boolean
    /** Disables both buttons while an async confirm handler runs. */
    busy?: boolean
  }>(),
  {
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    destructive: false,
    busy: false,
  },
)

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

// Per-instance id so two ConfirmDialogs on the same page don't share
// an aria-labelledby target.
const titleId = useId()
</script>

<template>
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    @click.self="emit('cancel')"
  >
    <div class="modal">
      <h2 :id="titleId">{{ title }}</h2>
      <div class="body">
        <slot />
      </div>
      <div class="actions">
        <button
          type="button"
          class="btn cancel"
          :disabled="busy"
          @click="emit('cancel')"
        >
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="btn confirm"
          :class="{ destructive }"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
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
  font-family: inherit;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cancel {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-muted);
}

.confirm {
  background: var(--color-accent);
  color: var(--color-on-accent);
}

.confirm.destructive {
  background: var(--color-grade-again-bg);
  color: var(--color-grade-again);
}
</style>
