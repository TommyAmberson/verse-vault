<script setup lang="ts">
import { useId } from 'vue'

defineProps<{
  /** Heading text; also wired as the dialog's accessible name. */
  title: string
}>()

const emit = defineEmits<{
  /** Backdrop click — the host decides whether that means cancel/close. */
  (e: 'dismiss'): void
}>()

const titleId = useId()
</script>

<template>
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    @click.self="emit('dismiss')"
  >
    <div class="modal">
      <h2 :id="titleId">{{ title }}</h2>
      <div class="body">
        <slot />
      </div>
      <div class="actions">
        <slot name="actions" />
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

.actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

/* Shared styling for action buttons the host passes into #actions.
 * `:slotted` is how a scoped child styles content provided by its parent. */
:slotted(.btn) {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-weight: 500;
  font-size: 0.95rem;
  border: 1px solid transparent;
  font-family: inherit;
  cursor: pointer;
}

:slotted(.btn:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}

:slotted(.btn.cancel) {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-muted);
}

:slotted(.btn.confirm) {
  background: var(--color-accent);
  color: var(--color-on-accent);
}

:slotted(.btn.confirm.destructive) {
  background: var(--color-grade-again-bg);
  color: var(--color-grade-again);
}
</style>
