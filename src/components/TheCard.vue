<script setup lang="ts">
defineProps<{
  book: string
  chapter: string
  verse: string
  text: string
}>()
</script>

<template>
  <div class="card">

    <h1>{{book}} {{chaper}}:{{verse}}</h1>
    <p>{{text}}</p>

  </div>
</template>
