<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'

import { reconcileDeviceSessions, useAuth } from '@/composables/useAuth'
import { useEmailRequest } from '@/composables/useEmailRequest'
import { RESET_SENT } from '@/lib/authEmail'

const { resetPassword, requestPasswordReset } = useAuth()
const route = useRoute()

const token = typeof route.query.token === 'string' ? route.query.token : ''
const state = ref<'form' | 'done' | 'invalid'>(token ? 'form' : 'invalid')
const password = ref('')
const email = ref('')
const error = ref('')
const pending = ref(false)
const {
  pending: newLinkPending,
  notice: newLinkNotice,
  run: sendNewLink,
} = useEmailRequest(
  () => requestPasswordReset(email.value),
  () => RESET_SENT,
)

async function submitPassword() {
  error.value = ''
  pending.value = true
  let result
  try {
    result = await resetPassword(token, password.value)
    // The reset ended every session for this account, including any this
    // device still holds. Drop them now so "Sign in" doesn't land on a
    // dead session. The button stays disabled meanwhile: a second submit
    // would find the token spent and report the link invalid.
    if (!result?.error) await reconcileDeviceSessions()
  } catch {
    error.value = 'Something went wrong. Try again.'
    return
  } finally {
    pending.value = false
  }
  if (!result?.error) {
    state.value = 'done'
  } else if (result.error.code === 'INVALID_TOKEN') {
    state.value = 'invalid'
  } else {
    error.value = result.error.message ?? 'Something went wrong. Try again.'
  }
}
</script>

<template>
  <div class="reset">
    <h2>Reset your password</h2>

    <form v-if="state === 'form'" class="auth-card" @submit.prevent="submitPassword">
      <input
        v-model="password"
        type="password"
        placeholder="New password"
        aria-label="New password"
        autocomplete="new-password"
        required
        class="auth-field"
      />
      <p v-if="error" class="auth-error">{{ error }}</p>
      <button type="submit" class="auth-submit" :disabled="pending">
        {{ pending ? 'Please wait…' : 'Set new password' }}
      </button>
    </form>

    <div v-else-if="state === 'done'" class="auth-card">
      <p>Password changed. You've been signed out everywhere.</p>
      <RouterLink to="/profiles?force=1" class="auth-submit">Sign in</RouterLink>
    </div>

    <form v-else class="auth-card" @submit.prevent="sendNewLink">
      <p>This link is no longer valid. Enter your email for a new one.</p>
      <input
        v-model="email"
        type="email"
        placeholder="Email"
        aria-label="Email"
        autocomplete="email"
        required
        class="auth-field"
      />
      <p v-if="newLinkNotice" class="auth-notice" role="status">{{ newLinkNotice }}</p>
      <button type="submit" class="auth-submit" :disabled="newLinkPending">
        {{ newLinkPending ? 'Please wait…' : 'Email me a new link' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.reset {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 100%;
  max-width: 22rem;
}
</style>
