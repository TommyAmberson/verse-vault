<script setup lang="ts">
// Placeholder shell for app-wide preferences (theme, notifications, etc.).
// Empty at launch — the spec explicitly allows this.
</script>

<template>
  <div class="preferences">
    <p class="placeholder">App-wide preferences will live here.</p>
  </div>
</template>

<style scoped>
.preferences {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.placeholder {
  margin: 0;
  padding: 2rem;
  text-align: center;
  color: var(--color-muted);
  background: var(--color-bg-card);
  border: 1px dashed var(--color-border);
  border-radius: 8px;
  font-style: italic;
}
</style>
