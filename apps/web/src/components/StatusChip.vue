<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Colour intent. `accent` for positive/active states, `warning`
     *  for in-progress/attention states, `muted` for inactive states. */
    variant: 'accent' | 'warning' | 'muted'
    /** Visual density. `sm` matches the per-deck status pill in
     *  MaterialView; `xs` matches the tighter pill on ProfileCard. */
    size?: 'sm' | 'xs'
  }>(),
  { size: 'sm' },
)
</script>

<template>
  <span class="chip" :class="[`chip-${variant}`, `chip-${size}`]">
    <slot />
  </span>
</template>

<style scoped>
.chip {
  display: inline-block;
  border-radius: 999px;
  text-transform: uppercase;
  font-weight: 500;
}

.chip-sm {
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  padding: 0.05rem 0.45rem;
}

.chip-xs {
  font-size: 0.65rem;
  letter-spacing: 0.04em;
  padding: 0.1rem 0.4rem;
}

.chip-accent {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.chip-warning {
  background: var(--color-grade-hard-bg);
  color: var(--color-grade-hard);
}

.chip-muted {
  background: var(--color-bg-card);
  color: var(--color-muted);
  border: 1px solid var(--color-border);
}
</style>
