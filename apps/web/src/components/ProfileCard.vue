<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import type { ProfileRow } from '@/lib/engine/registry'

const props = defineProps<{
  profile: ProfileRow
  /** Whether this card represents the currently-active profile. The
   *  kebab's "Sign out" item only renders when true (see component
   *  doc comment for why). */
  active: boolean
}>()

const emit = defineEmits<{
  (e: 'enter'): void
  (e: 'sign-out'): void
  (e: 'delete'): void
}>()

const menuOpen = ref(false)

function toggleMenu(ev: Event) {
  ev.stopPropagation()
  menuOpen.value = !menuOpen.value
}

function closeMenu() {
  menuOpen.value = false
}

// Click-outside-to-close: a window-level handler is cheaper than a
// transparent overlay and doesn't intercept clicks on other cards.
function onWindowClick() {
  if (menuOpen.value) menuOpen.value = false
}
window.addEventListener('click', onWindowClick)
onBeforeUnmount(() => window.removeEventListener('click', onWindowClick))

const initials = computed(() => {
  const source = props.profile.displayName || props.profile.email
  const parts = source.trim().split(/\s+/)
  const letters = parts.length >= 2
    ? parts[0]![0]! + parts[parts.length - 1]![0]!
    : source.slice(0, 2)
  return letters.toUpperCase()
})

const lastUsedLabel = computed(() => {
  const deltaSecs = Math.max(0, Math.floor(Date.now() / 1000) - props.profile.lastUsedAt)
  if (deltaSecs < 60) return 'just now'
  if (deltaSecs < 3600) return `${Math.floor(deltaSecs / 60)}m ago`
  if (deltaSecs < 86400) return `${Math.floor(deltaSecs / 3600)}h ago`
  if (deltaSecs < 86400 * 30) return `${Math.floor(deltaSecs / 86400)}d ago`
  return new Date(props.profile.lastUsedAt * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
})

function onSignOutClick(ev: Event) {
  ev.stopPropagation()
  closeMenu()
  emit('sign-out')
}

function onDeleteClick(ev: Event) {
  ev.stopPropagation()
  closeMenu()
  emit('delete')
}
</script>

<template>
  <button type="button" class="card" @click="emit('enter')">
    <div class="avatar">
      <img v-if="profile.image" :src="profile.image" :alt="profile.displayName" />
      <span v-else class="initials">{{ initials }}</span>
    </div>
    <div class="meta">
      <p class="name">{{ profile.displayName }}</p>
      <p class="email">{{ profile.email }}</p>
      <p class="last-used">Last used {{ lastUsedLabel }}</p>
    </div>
    <div class="kebab-wrap" @click.stop>
      <button
        type="button"
        class="kebab"
        aria-label="Profile menu"
        :aria-expanded="menuOpen"
        @click="toggleMenu"
      >
        ⋮
      </button>
      <div v-if="menuOpen" class="menu" role="menu">
        <button
          v-if="active"
          type="button"
          class="menu-item"
          role="menuitem"
          @click="onSignOutClick"
        >
          Sign out
        </button>
        <button
          type="button"
          class="menu-item destructive"
          role="menuitem"
          @click="onDeleteClick"
        >
          Delete profile
        </button>
      </div>
    </div>
  </button>
</template>

<style scoped>
.card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.75rem 1rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  text-align: left;
  font-family: inherit;
  color: var(--color-text);
  cursor: pointer;
  position: relative;
}

.card:hover {
  background: var(--color-bg);
}

.avatar {
  flex: 0 0 auto;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 999px;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  font-weight: 600;
  font-size: 0.9rem;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.meta p {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name {
  font-weight: 600;
  font-size: 0.95rem;
}

.email {
  font-size: 0.8rem;
  color: var(--color-muted);
}

.last-used {
  font-size: 0.75rem;
  color: var(--color-muted);
}

.kebab-wrap {
  position: relative;
  flex: 0 0 auto;
}

.kebab {
  background: none;
  border: none;
  font-size: 1.2rem;
  line-height: 1;
  padding: 0.25rem 0.5rem;
  color: var(--color-muted);
  cursor: pointer;
  border-radius: 4px;
}

.kebab:hover {
  color: var(--color-text);
  background: var(--color-accent-soft);
}

.menu {
  position: absolute;
  top: calc(100% + 0.25rem);
  right: 0;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  min-width: 9rem;
  z-index: 10;
  overflow: hidden;
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

.menu-item.destructive {
  color: var(--color-grade-again);
}
</style>
