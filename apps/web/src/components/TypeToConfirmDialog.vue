<script setup lang="ts">
import { ref, useId } from 'vue'

const props = withDefaults(
  defineProps<{
    title: string
    confirmLabel?: string
    cancelLabel?: string
    /** The exact string the user must type to enable confirm. */
    matchText: string
    busy?: boolean
  }>(),
  {
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    busy: false,
  },
)

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const typed = ref('')
const titleId = useId()
const inputId = useId()

const matched = () => typed.value.trim() === props.matchText
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
        <label :for="inputId" class="match-label">
          Type <code>{{ matchText }}</code> to confirm
        </label>
        <input
          :id="inputId"
          v-model="typed"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="match-input"
        />
      </div>
      <div class="actions">
        <button type="button" class="btn cancel" :disabled="busy" @click="emit('cancel')">
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="btn confirm destructive"
          :disabled="busy || !matched()"
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
  color: var(--color-muted);
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.match-label {
  font-size: 0.85rem;
}

.match-label code {
  color: var(--color-text);
  font-family: monospace;
}

.match-input {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: 0.9rem;
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

.confirm.destructive {
  background: var(--color-grade-again-bg);
  color: var(--color-grade-again);
}
</style>
