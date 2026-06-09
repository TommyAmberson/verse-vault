<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuth } from '@/composables/useAuth'
import { countAllQueuedEvents } from '@/lib/engine/persistence'

const { syncState, activeProfile } = useAuth()
const router = useRouter()
const route = useRoute()

const pending = ref<number>(0)

async function refresh() {
  // Skip the IDB read when the banner is invisible. The watcher re-fires
  // on syncState flips, so the count populates the moment offline shows up.
  if (!activeProfile.value || syncState.value === 'online') {
    pending.value = 0
    return
  }
  try {
    pending.value = await countAllQueuedEvents()
  } catch {
    pending.value = 0
  }
}

watch([syncState, () => route.fullPath, activeProfile], refresh, { immediate: true })

const visible = computed(() => activeProfile.value != null && syncState.value !== 'online')

const message = computed(() => {
  const n = pending.value
  const pluralised = n === 1 ? '1 grade' : `${n} grades`
  if (syncState.value === 'offline') {
    return n === 0
      ? 'Offline — changes will sync when you reconnect.'
      : `Offline — ${pluralised} queued for next sync.`
  }
  if (syncState.value === 'rate-limited') {
    // No retry-after surfaced from the auth client today; the next
    // navigation will re-issue getSession() and flip the state if the
    // bucket has refilled. Tell the user to give it a beat rather
    // than poke at it like a sign-in problem.
    return n === 0
      ? 'Rate limited — give it a moment, then try again.'
      : `Rate limited — ${pluralised} queued; the next request will retry.`
  }
  // signed-out: server reachable, just no session.
  return n === 0 ? 'Sign in to sync.' : `Sign in to sync ${pluralised}.`
})

function onClick() {
  // Rate-limited isn't a sign-in problem; clicking should not bounce
  // the user to the picker. The banner stays as a passive indicator
  // until a future navigation flips syncState back to 'online'.
  if (syncState.value === 'rate-limited') return
  void router.push({ name: 'signin', query: { redirect: route.fullPath } })
}
</script>

<template>
  <button
    v-if="visible"
    type="button"
    class="offline-banner"
    :class="{
      'is-offline': syncState === 'offline',
      'is-passive': syncState === 'rate-limited',
    }"
    :disabled="syncState === 'rate-limited'"
    aria-live="polite"
    @click="onClick"
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

.offline-banner.is-passive {
  cursor: default;
  opacity: 1;
}

.offline-banner.is-passive:hover {
  filter: none;
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
