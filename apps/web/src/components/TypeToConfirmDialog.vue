<script setup lang="ts">
import { computed, ref, useId } from 'vue'

import BaseModal from '@/components/BaseModal.vue'

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
const inputId = useId()

const matched = computed(() => typed.value.trim() === props.matchText)
</script>

<template>
  <BaseModal :title="title" @dismiss="emit('cancel')">
    <div class="ttc-body">
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
    <template #actions>
      <button type="button" class="btn cancel" :disabled="busy" @click="emit('cancel')">
        {{ cancelLabel }}
      </button>
      <button
        type="button"
        class="btn confirm destructive"
        :disabled="busy || !matched"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.ttc-body {
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
</style>
