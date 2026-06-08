<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useAuth } from '@/composables/useAuth'
import { profileInitials } from '@/lib/profile'

const { activeProfile, signOut } = useAuth()
const router = useRouter()

const open = ref(false)

const initials = computed(() =>
  activeProfile.value ? profileInitials(activeProfile.value) : '',
)

function toggle(ev: Event) {
  ev.stopPropagation()
  open.value = !open.value
}

function close() {
  open.value = false
}

// Click-outside-to-close: same window-listener pattern as ProfileCard's
// kebab — cheaper than a transparent overlay, doesn't intercept other
// interactive elements.
function onWindowClick() {
  if (open.value) open.value = false
}
function onWindowKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && open.value) close()
}
onMounted(() => {
  window.addEventListener('click', onWindowClick)
  window.addEventListener('keydown', onWindowKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('click', onWindowClick)
  window.removeEventListener('keydown', onWindowKeydown)
})

function goSwitchProfile() {
  close()
  void router.push('/profiles?force=1')
}

async function onSignOut() {
  close()
  // signOut() with no arg targets the active profile, revokes its
  // server session, and clears in-memory state — the router guard
  // then falls through to /profiles on the next navigation. We push
  // explicitly so the user sees the picker immediately rather than
  // staying on a now-signed-out view.
  await signOut()
  await router.push('/profiles')
}
</script>

<template>
  <div v-if="activeProfile" class="avatar-wrap" @click.stop>
    <button
      type="button"
      class="avatar-btn"
      :aria-expanded="open"
      aria-haspopup="menu"
      aria-label="Account menu"
      @click="toggle"
    >
      <img
        v-if="activeProfile.image"
        :src="activeProfile.image"
        :alt="activeProfile.displayName"
      />
      <span v-else class="initials">{{ initials }}</span>
    </button>
    <div v-if="open" class="menu" role="menu">
      <div class="menu-header">
        <p class="name">{{ activeProfile.displayName }}</p>
        <p class="email">{{ activeProfile.email }}</p>
      </div>
      <button type="button" class="menu-item" role="menuitem" @click="goSwitchProfile">
        Switch profile
      </button>
      <button type="button" class="menu-item" role="menuitem" @click="onSignOut">
        Sign out
      </button>
    </div>
  </div>
</template>

<style scoped>
.avatar-wrap {
  position: relative;
  flex: 0 0 auto;
  /* The site header is a `1fr auto 1fr` grid; the wrap is the third
     track. Pin it right so the avatar trails the nav rather than
     centering in its track. */
  justify-self: end;
}

.avatar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border: none;
  padding: 0;
  font-family: inherit;
  font-weight: 600;
  font-size: 0.75rem;
  cursor: pointer;
  overflow: hidden;
}

.avatar-btn:hover {
  background: var(--color-accent);
  color: var(--color-on-accent);
}

.avatar-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.avatar-btn img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.initials {
  letter-spacing: 0.05em;
}

.menu {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  min-width: 12rem;
  z-index: 10;
  overflow: hidden;
}

.menu-header {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.menu-header p {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name {
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--color-text);
}

.email {
  font-size: 0.75rem;
  color: var(--color-muted);
}

.menu-item {
  background: none;
  border: none;
  padding: 0.5rem 0.75rem;
  text-align: left;
  font-family: inherit;
  font-size: 0.85rem;
  color: var(--color-text);
  cursor: pointer;
}

.menu-item:hover {
  background: var(--color-bg);
}

.menu-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
  background: var(--color-bg);
}
</style>
