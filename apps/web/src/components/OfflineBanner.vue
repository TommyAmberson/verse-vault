<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuth } from '@/composables/useAuth'
import { countQueuedEvents } from '@/lib/engine/persistence'

const { isOnline, activeProfile } = useAuth()
const router = useRouter()
const route = useRoute()

const pending = ref<number>(0)

async function refresh() {
  if (!activeProfile.value) {
    pending.value = 0
    return
  }
  try {
    // Sum the queue across every material the user is enrolled in.
    // Without a materialId-list helper we can't count globally; for
    // the banner copy "N grades" is good enough as a per-material
    // proxy of the currently-routed material when applicable. For
    // routes outside a material context we show 0.
    const materialId = typeof route.params.materialId === 'string'
      ? route.params.materialId
      : null
    pending.value = materialId ? await countQueuedEvents(materialId) : 0
  } catch {
    pending.value = 0
  }
}

watch([isOnline, () => route.fullPath, activeProfile], refresh, { immediate: true })

const visible = computed(() => activeProfile.value != null && !isOnline.value)

const message = computed(() => {
  const n = pending.value
  if (n === 0) return 'Offline — sign in to sync.'
  if (n === 1) return 'Offline — sign in to sync 1 grade.'
  return `Offline — sign in to sync ${n} grades.`
})

function onSignIn() {
  void router.push({ name: 'signin', query: { redirect: route.fullPath } })
}
</script>

<template>
  <button
    v-if="visible"
    type="button"
    class="offline-banner"
    aria-live="polite"
    @click="onSignIn"
  >
    <span class="dot" aria-hidden="true" />
    <span class="msg">{{ message }}</span>
  </button>
</template>

<style scoped>
.offline-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 1rem;
  background: var(--color-grade-hard-bg);
  color: var(--color-grade-hard);
  border: none;
  border-bottom: 1px solid var(--color-border);
  font: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.offline-banner:hover {
  filter: brightness(1.05);
}

.dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: currentColor;
}

.msg {
  font-weight: 500;
}
</style>
