<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

import BaseModal from '@/components/BaseModal.vue'
import { getIdbInterruption, onIdbInterruption } from '@/lib/engine/idbOpen'

// Mounted in App rather than a view: a blocked open stalls the router's
// boot guard, so no view renders until it clears.
const interruption = ref(getIdbInterruption())
const unsubscribe = onIdbInterruption((state) => {
  interruption.value = state
})
onBeforeUnmount(unsubscribe)

function reload() {
  window.location.reload()
}
</script>

<template>
  <!-- No dismiss: the app can't work around either state, so the
       backdrop click is a no-op rather than a way into a broken page. -->
  <BaseModal
    v-if="interruption === 'blocked'"
    title="Close your other verse-vault tab"
  >
    <p>
      verse-vault needs to update the data it keeps on this device, but a
      verse-vault tab still running an older version is holding it open.
    </p>
    <p>Close or refresh that tab, and this one will carry on by itself.</p>
  </BaseModal>
  <BaseModal
    v-else-if="interruption === 'superseded'"
    title="verse-vault was updated in another tab"
  >
    <p>
      A newer version of verse-vault in another tab has updated the data
      this device keeps. Reload to keep going.
    </p>
    <template #actions>
      <button type="button" class="btn confirm" @click="reload">Reload</button>
    </template>
  </BaseModal>
  <BaseModal
    v-else-if="interruption === 'removed'"
    title="verse-vault was reset in another tab"
  >
    <p>
      Another verse-vault tab removed or reset the data this device keeps.
      Reload to keep going.
    </p>
    <template #actions>
      <button type="button" class="btn confirm" @click="reload">Reload</button>
    </template>
  </BaseModal>
</template>
