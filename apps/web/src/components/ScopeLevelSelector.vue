<script setup lang="ts" generic="T extends string">
import { computed } from 'vue'

interface Level {
  value: T
  label: string
}

const props = defineProps<{
  modelValue: T
  /** Levels in order from "off" / least to "all" / most. The first
   *  entry should represent the empty state. */
  levels: Level[]
  /** Caption rendered below the track describing the current state. */
  description?: string
  /** Disables interaction (e.g. while a save is in flight). */
  disabled?: boolean
  /** Accessible label announced to screen readers as a group. */
  ariaLabel?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [T] }>()

const selectedIndex = computed(() =>
  props.levels.findIndex((l) => l.value === props.modelValue),
)

function select(value: T) {
  if (props.disabled) return
  if (value !== props.modelValue) emit('update:modelValue', value)
}
</script>

<template>
  <div
    class="scope-level"
    :class="{ 'is-disabled': disabled }"
    role="radiogroup"
    :aria-label="ariaLabel"
  >
    <div class="track">
      <template v-for="(level, i) in levels" :key="level.value">
        <span
          v-if="i > 0"
          class="rail"
          :class="{ 'rail-on': i <= selectedIndex }"
          aria-hidden="true"
        />
        <button
          type="button"
          class="stop"
          :class="{
            'stop-on': i > 0 && i <= selectedIndex,
            'stop-cursor': i === selectedIndex,
            'stop-off-state': i === 0 && selectedIndex === 0,
          }"
          role="radio"
          :aria-checked="i === selectedIndex"
          :tabindex="i === selectedIndex ? 0 : -1"
          :disabled="disabled"
          @click="select(level.value)"
        >
          <span class="dot" aria-hidden="true" />
          <span class="label">{{ level.label }}</span>
        </button>
      </template>
    </div>
    <p v-if="description" class="description">{{ description }}</p>
  </div>
</template>

<style scoped>
.scope-level {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.scope-level.is-disabled {
  opacity: 0.55;
  pointer-events: none;
}

.track {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  align-items: start;
  padding: 0.75rem 0.5rem 0.4rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.rail {
  height: 2px;
  margin-top: 0.5rem;
  background: var(--color-border);
  transition: background 0.18s ease;
}

.rail-on {
  background: var(--color-accent);
}

.stop {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  padding: 0;
  border: 0;
  background: none;
  color: var(--color-muted);
  font-family: inherit;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: lowercase;
  cursor: pointer;
}

.stop:focus-visible {
  outline: none;
}

.stop:focus-visible .dot {
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.dot {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 999px;
  border: 2px solid var(--color-border);
  background: var(--color-bg-card);
  transition:
    background 0.18s ease,
    border-color 0.18s ease,
    transform 0.18s ease;
}

.stop-on .dot {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.stop-cursor .dot {
  transform: scale(1.25);
  box-shadow: 0 0 0 4px var(--color-accent-soft);
}

/* The "off" stop, when the user is currently in the off state, gets
 * its own dim-but-visible affordance — the dot stays hollow so it
 * doesn't read as "active". */
.stop-off-state .dot {
  border-color: var(--color-text);
  background: var(--color-bg-card);
}
.stop-off-state .label {
  color: var(--color-text);
}

.label {
  white-space: nowrap;
  transition: color 0.18s ease;
}

.stop-on .label,
.stop-cursor .label {
  color: var(--color-text);
}

.stop:hover:not(:disabled) .dot {
  border-color: var(--color-accent);
}

.description {
  margin: 0;
  font-size: 0.82rem;
  color: var(--color-muted);
  font-style: italic;
}
</style>
