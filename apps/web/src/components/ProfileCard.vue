<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import StatusChip from '@/components/StatusChip.vue'
import type { ProfileRow } from '@/lib/engine/registry'
import { profileInitials } from '@/lib/profile'

const props = defineProps<{
  profile: ProfileRow
  /** True when this card represents the currently-active profile. */
  active: boolean
  /** Whether the profile has a live session on this device. Drives
   *  the chip + whether card click means enter or re-auth. */
  signedIn: boolean
}>()

const emit = defineEmits<{
  /** Clicked a signed-in card — swap workspace to this profile. */
  enter: []
  /** Clicked a signed-out card — re-auth required to use it. */
  reauth: []
  'sign-out': []
  delete: []
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
onMounted(() => window.addEventListener('click', onWindowClick))
onBeforeUnmount(() => window.removeEventListener('click', onWindowClick))

const initials = computed(() => profileInitials(props.profile))

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

// Every kebab item does the same three things — stop the card's click
// handler firing, close the menu, then emit. One helper keeps the
// handler list from growing 1:1 with the menu.
function menuAction(ev: Event, action: 'sign-out' | 'delete') {
  ev.stopPropagation()
  closeMenu()
  // `defineEmits` types `emit` as an overload set — one signature per
  // declared event — and TS can't match a union argument against
  // overloads. `action` is always one of the declared events, so
  // narrowing to a single name is sound.
  emit(action as 'sign-out')
}

// The card surface is a role="button" div rather than a native
// <button>, so the kebab + menu items inside it remain valid
// interactive descendants. Native button-in-button is invalid HTML
// and confuses screen readers.
function onCardActivate() {
  if (props.signedIn) emit('enter')
  else emit('reauth')
}

function onCardKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault()
    onCardActivate()
  }
}
</script>

<template>
  <div
    class="card"
    :class="{ 'is-active': active, 'is-signed-out': !signedIn }"
    role="button"
    tabindex="0"
    @click="onCardActivate"
    @keydown="onCardKeydown"
  >
    <div class="avatar">
      <img v-if="profile.image" :src="profile.image" :alt="profile.displayName" />
      <span v-else class="initials">{{ initials }}</span>
    </div>
    <div class="meta">
      <p class="name">
        {{ profile.displayName }}
        <StatusChip :variant="signedIn ? 'accent' : 'muted'" size="xs">
          {{ signedIn ? 'Signed in' : 'Signed out' }}
        </StatusChip>
      </p>
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
          v-if="signedIn"
          type="button"
          class="menu-item"
          role="menuitem"
          @click="menuAction($event, 'sign-out')"
        >
          Sign out
        </button>
        <button
          type="button"
          class="menu-item destructive"
          role="menuitem"
          @click="menuAction($event, 'delete')"
        >
          Delete profile
        </button>
      </div>
    </div>
  </div>
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

.card.is-active {
  border-color: var(--color-accent);
}

.card.is-signed-out {
  opacity: 0.75;
}

.card.is-signed-out:hover {
  opacity: 1;
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
  display: flex;
  align-items: center;
  gap: 0.4rem;
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
