<script setup lang="ts">
import { RouterLink } from 'vue-router'

defineProps<{
  newToMemorize: number
}>()
</script>

<template>
  <nav class="mobile-tab-bar" aria-label="Primary">
    <RouterLink to="/home" class="tab">
      <svg
        class="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 11l9-8 9 8v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2V11z" />
      </svg>
      <span class="label">Home</span>
    </RouterLink>
    <RouterLink to="/review" class="tab">
      <svg
        class="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
      <span class="label">Review</span>
    </RouterLink>
    <RouterLink to="/memorize" class="tab">
      <svg
        class="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
        <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
      </svg>
      <span class="label">Memorize</span>
      <span v-if="newToMemorize > 0" class="pill">{{ newToMemorize }}</span>
    </RouterLink>
    <RouterLink to="/settings" class="tab">
      <svg
        class="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3" />
        <path
          d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 0 1 0 4h-.1A1.7 1.7 0 0 0 19.4 15z"
        />
      </svg>
      <span class="label">Settings</span>
    </RouterLink>
    <RouterLink to="/stats" class="tab">
      <svg
        class="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <line x1="12" y1="20" x2="12" y2="10" />
        <line x1="18" y1="20" x2="18" y2="4" />
        <line x1="6" y1="20" x2="6" y2="16" />
      </svg>
      <span class="label">Stats</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
/* Mounted only when a user is signed in (App.vue gates `<MobileTabBar
   v-if="user">`); the media query then keeps it hidden at desktop
   widths via a CSS-only branch. Same shape across viewports — no
   JS-driven mount/unmount on resize. See docs/web-nav.md §Decisions. */
.mobile-tab-bar {
  display: none;
}

@media (max-width: 720px) {
  .mobile-tab-bar {
    display: flex;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 5;
    /* The padded height of the bar drives the `.site` padding-bottom
       in App.vue — keep `--mobile-tab-bar-h` in sync with the natural
       height the contents produce here. The `env(...)` fallback covers
       browsers without safe-area-inset support; without it, an
       unresolved env() would void the entire `calc()` and collapse
       padding to zero. */
    min-height: var(--mobile-tab-bar-h);
    background: var(--color-bg-card);
    border-top: 1px solid var(--color-border);
    justify-content: space-around;
    padding: 0.4rem 0.25rem calc(0.4rem + env(safe-area-inset-bottom, 0px));
  }
}

.tab {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  flex: 1 1 0;
  min-width: 0;
  padding: 0.25rem 0.3rem;
  border-radius: 4px;
  text-decoration: none;
  color: var(--color-muted);
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.tab.router-link-active {
  color: var(--color-accent);
}

.tab:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.icon {
  width: 1.35rem;
  height: 1.35rem;
}

.label {
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.pill {
  position: absolute;
  top: 0;
  right: 0.35rem;
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 0.6rem;
  font-weight: 600;
  padding: 0.05rem 0.3rem;
  border-radius: 999px;
  line-height: 1.3;
}
</style>
