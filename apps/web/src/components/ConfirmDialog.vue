<script setup lang="ts">
import BaseModal from '@/components/BaseModal.vue'

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
</script>

<template>
  <BaseModal :title="title" @dismiss="emit('cancel')">
    <slot />
    <template #actions>
      <button type="button" class="btn cancel" :disabled="busy" @click="emit('cancel')">
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
    </template>
  </BaseModal>
</template>
