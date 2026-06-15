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
// Keydown listener runs on the CAPTURE phase so it sees keys before the
// active route's own capture-phase handlers do — ReviewView and
// MemorizeView each register `keydown` with `{capture: true}` and treat
// 1-4 / Enter / Space as grade input. While the popover is open, swallow
// those keys before they reach the underlying view; otherwise a user
// typing "1" to dismiss the menu would accidentally grade the current
// card. Escape closes the menu and is also swallowed so it doesn't
// trigger any escape-handlers in the underlying view.
const GRADE_KEYS = new Set(['1', '2', '3', '4', 'Enter', ' '])
function onWindowKeydown(ev: KeyboardEvent) {
  if (!open.value) return
  if (ev.key === 'Escape') {
    ev.stopImmediatePropagation()
    close()
    return
  }
  if (GRADE_KEYS.has(ev.key)) {
    ev.stopImmediatePropagation()
    ev.preventDefault()
  }
}
onMounted(() => {
  window.addEventListener('click', onWindowClick)
  window.addEventListener('keydown', onWindowKeydown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('click', onWindowClick)
  window.removeEventListener('keydown', onWindowKeydown, true)
})

function goAccount() {
  close()
  void router.push('/settings/account')
}

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
  //
  // The push runs in a finally so an IDB or revoke failure inside
  // signOut() still routes the user to the picker. Landing on the
  // picker (where they can retry or see their profile listed) is
  // always better than being stranded on a workspace view whose
  // sign-out attempt half-succeeded.
  try {
    await signOut()
  } finally {
    void router.push('/profiles')
  }
}
</script>

<template>
  <!-- The wrap renders unconditionally so the parent grid's third
       column always has an anchor. Without it, a brief window during
       cold boot (before activeProfile resolves from IDB) collapses the
       1fr/auto/1fr header grid to 1fr/auto and the brand + nav drift
       right. The avatar button + popover are still gated on
       activeProfile so signed-out / pre-boot states render no visible
       chrome here. -->
  <div class="avatar-wrap" @click.stop>
    <template v-if="activeProfile">
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
        <button type="button" class="menu-item" role="menuitem" @click="goAccount">
          Account
        </button>
        <button type="button" class="menu-item" role="menuitem" @click="goSwitchProfile">
          Switch profile
        </button>
        <button type="button" class="menu-item" role="menuitem" @click="onSignOut">
          Sign out
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.avatar-wrap {
  position: relative;
  flex: 0 0 auto;
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
