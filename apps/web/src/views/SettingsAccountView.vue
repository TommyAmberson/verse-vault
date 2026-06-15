<script setup lang="ts">
// Placeholder shell. The next commit migrates Export · Import · Delete-all-progress
// out of ProfilePickerView's kebab into this section (closes issue #92).
</script>

<template>
  <div class="account">
    <p class="placeholder">Account-management actions will live here.</p>
  </div>
</template>

<style scoped>
.account {
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
