<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

interface Section {
  name: string
  label: string
  path: string
}

const SECTIONS: Section[] = [
  { name: 'settings-account', label: 'Account', path: '/settings/account' },
  { name: 'settings-preferences', label: 'Preferences', path: '/settings/preferences' },
  { name: 'settings-materials', label: 'Materials', path: '/settings/materials' },
]

const route = useRoute()

// Match either by route name (set on the child routes) or by path prefix,
// so the rail highlights even when a future child route nests deeper
// (e.g. /settings/materials/<materialId>). The path branch requires an
// exact match OR a `/`-anchored prefix so a future sibling like
// `/settings/materials-archive` won't incorrectly highlight Materials.
const activeSection = computed<string>(() => {
  const byName = SECTIONS.find((s) => s.name === route.name)
  if (byName) return byName.name
  const byPath = SECTIONS.find(
    (s) => route.path === s.path || route.path.startsWith(s.path + '/'),
  )
  return byPath?.name ?? SECTIONS[0]!.name
})

const activeLabel = computed(
  () => SECTIONS.find((s) => s.name === activeSection.value)?.label ?? '',
)
</script>

<template>
  <div class="settings">
    <h2>Settings</h2>
    <div class="layout">
      <nav class="rail" aria-label="Settings sections">
        <RouterLink
          v-for="s in SECTIONS"
          :key="s.name"
          :to="s.path"
          class="rail-link"
          :class="{ 'rail-link-active': s.name === activeSection }"
        >
          {{ s.label }}
        </RouterLink>
      </nav>
      <section class="content" :aria-label="activeLabel">
        <RouterView />
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  width: 100%;
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

h2 {
  font-size: 1.5rem;
  margin: 0;
}

.layout {
  display: grid;
  grid-template-columns: 11rem 1fr;
  gap: 1.5rem;
  align-items: start;
}

.rail {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.4rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.rail-link {
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  color: var(--color-muted);
  text-decoration: none;
  font-size: 0.95rem;
  font-weight: 500;
  transition: color 0.15s ease, background 0.15s ease;
}

.rail-link:hover {
  color: var(--color-text);
}

.rail-link-active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}

.rail-link:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.content {
  min-width: 0;
}

/* On narrow viewports the rail becomes a horizontal scrolling strip
   above the content. Same routes, same DOM — only the rail flips
   between column (desktop) and row (mobile). */
@media (max-width: 720px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .rail {
    flex-direction: row;
    gap: 0.25rem;
    overflow-x: auto;
    padding: 0.3rem;
  }

  .rail-link {
    flex: 0 0 auto;
    padding: 0.4rem 0.85rem;
    font-size: 0.9rem;
  }
}
</style>
