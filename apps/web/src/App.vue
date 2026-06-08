<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import { api } from '@/api'
import AppAvatar from '@/components/AppAvatar.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import OfflineBanner from '@/components/OfflineBanner.vue'
import { useAuth } from '@/composables/useAuth'

const { activeProfile, conflict, acceptPendingSignIn, cancelPendingSignIn } = useAuth()
const route = useRoute()

// Driven by the active profile (cached locally) rather than Better
// Auth's reactive session. The profile is the durable identity;
// session validity is a separate online/offline concern handled by
// the offline banner. Reading from activeProfile lets the nav stay
// rendered when the user is offline with a valid prior profile.
const user = computed(() =>
  activeProfile.value
    ? { email: activeProfile.value.email, name: activeProfile.value.displayName }
    : null,
)
const newToMemorize = ref<number>(0)

async function refreshMemorizeCount() {
  if (!user.value) return
  try {
    const res = await api.getYears()
    newToMemorize.value = res.years.reduce((sum, y) => sum + y.newCardCount, 0)
  } catch {
    // Don't fail nav rendering on a count fetch error; leave at 0.
  }
}

// Refresh on auth change and after every navigation — graduations and
// material-picker writes both move this number.
watch(user, refreshMemorizeCount, { immediate: true })
watch(() => route.fullPath, refreshMemorizeCount)
</script>

<template>
  <div class="site">
    <header class="site-header">
      <RouterLink to="/" class="brand">verse-vault</RouterLink>
      <nav v-if="user" class="nav">
        <RouterLink to="/home">Home</RouterLink>
        <RouterLink to="/review">Review</RouterLink>
        <RouterLink to="/memorize" class="memorize-link">
          Memorize
          <span v-if="newToMemorize > 0" class="pill">{{ newToMemorize }}</span>
        </RouterLink>
        <RouterLink to="/settings">Settings</RouterLink>
        <RouterLink to="/stats">Stats</RouterLink>
      </nav>
      <AppAvatar />
    </header>
    <OfflineBanner />
    <ConfirmDialog
      v-if="conflict"
      title="Switch to a different account?"
      :confirm-label="`Switch to ${conflict.pendingUser.email}`"
      cancel-label="Stay signed in"
      @confirm="acceptPendingSignIn"
      @cancel="cancelPendingSignIn"
    >
      <p>
        You were signed in as <strong>{{ conflict.expectedEmail }}</strong>,
        but the sign-in just completed as
        <strong>{{ conflict.pendingUser.email }}</strong>. Switching will make
        the new account the active workspace and leave
        {{ conflict.expectedEmail }} on this device as a signed-out
        profile you can return to.
      </p>
    </ConfirmDialog>
    <main class="site-main">
      <RouterView />
    </main>
    <!-- API.Bible Starter-plan attribution: a visible citation +
         hyperlink to api.bible is required by their terms. The NKJV
         copyright line is the canonical Thomas Nelson citation
         (mirrored in NOTICE.md). -->
    <footer class="site-footer">
      <p>
        Scripture quotations marked NKJV are taken from the New King James
        Version®. Copyright © 1982 by Thomas Nelson. Used by permission.
        All rights reserved.
      </p>
      <p>
        Scripture text served via
        <a href="https://api.bible" target="_blank" rel="noopener">API.Bible</a>.
      </p>
    </footer>
  </div>
</template>

<style scoped>
.site {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
}

.site-header {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1.5rem;
  background: var(--color-bg-card);
  border-bottom: 1px solid var(--color-border);
}

.brand {
  font-weight: 600;
  color: var(--color-text);
  text-decoration: none;
  font-size: 1.1rem;
  justify-self: start;
}

.nav {
  display: flex;
  align-items: center;
  gap: 1rem;
  justify-self: center;
}

/* AppAvatar's `.avatar-wrap` outer is the third grid track. Pin it right. */
.site-header :deep(.avatar-wrap) {
  justify-self: end;
}

.nav :deep(a) {
  color: var(--color-muted);
  text-decoration: none;
  padding: 0.25rem 0.75rem;
  border-radius: 4px;
}

.nav :deep(a.router-link-active) {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.memorize-link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.pill {
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  line-height: 1.4;
}

.site-main {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: 2rem 1rem;
}

.site-footer {
  border-top: 1px solid var(--color-border);
  padding: 1rem 1.5rem;
  font-size: 0.8rem;
  color: var(--color-muted);
  line-height: 1.5;
  text-align: center;
}

.site-footer p {
  margin: 0;
}

.site-footer p + p {
  margin-top: 0.25rem;
}

.site-footer a {
  color: var(--color-muted);
  text-decoration: underline;
}

.site-footer a:hover {
  color: var(--color-text);
}
</style>
