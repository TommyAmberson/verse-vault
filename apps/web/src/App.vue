<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <div class="site">
    <header class="site-header">
      <RouterLink to="/" class="brand">verse-vault</RouterLink>
      <nav class="nav">
        <RouterLink to="/session">Session</RouterLink>
        <RouterLink to="/stats">Stats</RouterLink>
      </nav>
    </header>
    <main class="site-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.site {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
}

.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.5rem;
  background: var(--color-bg-card);
  border-bottom: 1px solid var(--color-border);
}

.brand {
  font-weight: 600;
  color: var(--color-text);
  text-decoration: none;
  font-size: 1.1rem;
}

.nav {
  display: flex;
  gap: 1rem;
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

.site-main {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: 2rem 1rem;
}
</style>
