<script setup lang="ts">
import { ref } from 'vue'

import type { SocialProvider } from '@/lib/authClient'

type SignInResult = { error?: { message?: string | null } | null } | undefined

const props = defineProps<{
  signInSocial: (provider: SocialProvider) => void
  signInEmail: (email: string, password: string) => Promise<SignInResult>
  signUpEmail: (email: string, password: string) => Promise<SignInResult>
}>()

const emit = defineEmits<{ (e: 'success'): void }>()

const mode = ref<'pick' | 'signin' | 'signup'>('pick')
const email = ref('')
const password = ref('')
const error = ref('')
const pending = ref(false)

async function submitEmail() {
  error.value = ''
  pending.value = true
  const fn = mode.value === 'signup' ? props.signUpEmail : props.signInEmail
  const result = await fn(email.value, password.value)
  pending.value = false
  if (result?.error) {
    error.value = result.error.message ?? 'Something went wrong'
  } else {
    emit('success')
  }
}
</script>

<template>
  <div class="auth-card">
    <template v-if="mode === 'pick'">
      <button class="provider-btn" @click="signInSocial('google')">
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          />
        </svg>
        Continue with Google
      </button>
      <div class="divider"><span>or</span></div>
      <button class="email-toggle" @click="mode = 'signin'">Sign in with email</button>
      <button class="email-toggle" @click="mode = 'signup'">Create account</button>
    </template>

    <template v-else>
      <button class="back-btn" @click="mode = 'pick'">← Back</button>
      <p class="form-title">{{ mode === 'signup' ? 'Create account' : 'Sign in' }}</p>
      <form @submit.prevent="submitEmail">
        <input
          v-model="email"
          type="email"
          placeholder="Email"
          autocomplete="email"
          required
          class="field"
        />
        <input
          v-model="password"
          type="password"
          placeholder="Password"
          autocomplete="current-password"
          required
          class="field"
        />
        <p v-if="error" class="error-msg">{{ error }}</p>
        <button type="submit" class="submit-btn" :disabled="pending">
          {{ pending ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in' }}
        </button>
      </form>
    </template>
  </div>
</template>

<style scoped>
.auth-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
  max-width: 22rem;
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.5rem;
}

.provider-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-card);
  color: var(--color-text);
  font-size: 0.9rem;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s;
}

.provider-btn:hover {
  background: var(--color-bg);
}

.divider {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--color-muted);
  font-size: 0.8rem;
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--color-border);
}

.email-toggle {
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-muted);
  font-size: 0.85rem;
  font-family: inherit;
  cursor: pointer;
  transition: color 0.15s;
}

.email-toggle:hover {
  color: var(--color-text);
}

.back-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-muted);
  font-size: 0.8rem;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  align-self: flex-start;
}

.back-btn:hover {
  color: var(--color-text);
}

.form-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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

.error-msg {
  font-size: 0.8rem;
  color: var(--color-error);
  margin: 0;
}

.submit-btn {
  width: 100%;
  padding: 0.6rem 0.75rem;
  background: var(--color-accent);
  border: none;
  border-radius: 6px;
  color: var(--color-on-accent);
  font-size: 0.9rem;
  font-family: inherit;
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
