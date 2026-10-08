<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'

import { useAuth } from '@/composables/useAuth'
import { RESET_SENT, emailRequestMessage } from '@/lib/authEmail'

const { resetPassword, requestPasswordReset } = useAuth()
const route = useRoute()

const token = typeof route.query.token === 'string' ? route.query.token : ''
const state = ref<'form' | 'done' | 'invalid'>(token ? 'form' : 'invalid')
const password = ref('')
const email = ref('')
const error = ref('')
const notice = ref('')
const pending = ref(false)

async function submitPassword() {
  error.value = ''
  pending.value = true
  const result = await resetPassword(token, password.value)
  pending.value = false
  if (!result?.error) {
    state.value = 'done'
  } else if (result.error.code === 'INVALID_TOKEN') {
    state.value = 'invalid'
  } else {
    error.value = result.error.message ?? 'Something went wrong. Try again.'
  }
}

async function submitNewLink() {
  pending.value = true
  const result = await requestPasswordReset(email.value)
  pending.value = false
  notice.value = emailRequestMessage(result, RESET_SENT)
}
</script>

<template>
  <div class="reset">
    <h2>Reset your password</h2>

    <form v-if="state === 'form'" class="card" @submit.prevent="submitPassword">
      <input
        v-model="password"
        type="password"
        placeholder="New password"
        autocomplete="new-password"
        required
        class="field"
      />
      <p v-if="error" class="error-msg">{{ error }}</p>
      <button type="submit" class="submit-btn" :disabled="pending">
        {{ pending ? 'Please wait…' : 'Set new password' }}
      </button>
    </form>

    <div v-else-if="state === 'done'" class="card">
      <p>Password changed. You've been signed out everywhere else.</p>
      <RouterLink to="/profiles" class="submit-btn">Sign in</RouterLink>
    </div>

    <form v-else class="card" @submit.prevent="submitNewLink">
      <p>This link is no longer valid. Enter your email for a new one.</p>
      <input
        v-model="email"
        type="email"
        placeholder="Email"
        autocomplete="email"
        required
        class="field"
      />
      <p v-if="notice" class="notice-msg" role="status">{{ notice }}</p>
      <button type="submit" class="submit-btn" :disabled="pending">
        {{ pending ? 'Please wait…' : 'Email me a new link' }}
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

.card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.5rem;
}

.card p {
  margin: 0;
  font-size: 0.9rem;
}

.field {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 0.9rem;
  font-family: inherit;
}

.field:focus {
  outline: none;
  border-color: var(--color-accent);
}

.notice-msg {
  color: var(--color-muted);
  font-size: 0.8rem;
}

.error-msg {
  color: var(--color-error);
  font-size: 0.8rem;
}

.submit-btn {
  display: block;
  width: 100%;
  padding: 0.6rem 0.75rem;
  background: var(--color-accent);
  border: none;
  border-radius: 6px;
  color: var(--color-on-accent);
  font-size: 0.9rem;
  font-family: inherit;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
}

.submit-btn:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
