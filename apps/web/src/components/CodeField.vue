<script setup lang="ts">
/** The one field for an emailed code: six digits on the number pad, offered
 *  for autofill from the message where the platform can, with a way to ask
 *  for a new code. */
const code = defineModel<string>({ required: true })
defineProps<{ resending?: boolean }>()
const emit = defineEmits<{ (e: 'resend'): void }>()

// Keeps the digits only, so a code pasted with spaces around or inside it
// still fits; a length limit on the input would cut the paste short instead.
// A pasted line holding a six-digit run keeps the last such run, so a new
// code pasted after an old one replaces it. The value is only rewritten when it changes, so typing keeps the
// caret where it was.
function onInput(event: Event) {
  const input = event.target as HTMLInputElement
  const runs = input.value.match(/\d{6}/g)
  const digits = (runs?.[runs.length - 1] ?? input.value.replace(/\D/g, '')).slice(0, 6)
  code.value = digits
  if (input.value !== digits) input.value = digits
}
</script>

<template>
  <div class="code-field">
    <input
      :value="code"
      type="text"
      inputmode="numeric"
      autocomplete="one-time-code"
      pattern="\d{6}"
      placeholder="6-digit code"
      aria-label="Code"
      required
      class="auth-field"
      @input="onInput"
    />
    <button type="button" class="link-btn" :disabled="resending" @click="emit('resend')">
      {{ resending ? 'Sending…' : 'Send a new code' }}
    </button>
  </div>
  <!-- A new code replaces the older one, as with most email codes. -->
  <p class="auth-notice">Only the code in the newest email works.</p>
</template>

<style scoped>
.code-field {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.code-field .auth-field {
  flex: 1;
  letter-spacing: 0.2em;
}

.code-field .link-btn {
  align-self: center;
  white-space: nowrap;
}
</style>
