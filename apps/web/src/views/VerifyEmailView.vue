<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import SignInForm from '@/components/SignInForm.vue'
import { reconcileDeviceSessions, useAuth } from '@/composables/useAuth'
import { VERIFY_SENT, emailRequestMessage, verificationTokenEmail } from '@/lib/authEmail'

const {
  activeProfile,
  profiles,
  signInSocial,
  signInEmail,
  signUpEmail,
  requestPasswordReset,
  enterProfile,
  verifyEmail,
  sendVerificationEmail,
} = useAuth()
const route = useRoute()

const token = typeof route.query.token === 'string' ? route.query.token : ''
const email = verificationTokenEmail(token)
const state = ref<'checking' | 'switch' | 'signin' | 'done' | 'invalid'>('checking')
const error = ref('')
const notice = ref('')
const pending = ref(false)

// A profile on this device that is signed in as the link's address.
const target = computed(() =>
  profiles.value.find(
    (p) => p.sessionToken !== null && p.email.toLowerCase() === email?.toLowerCase(),
  ),
)

// The server verifies only for the account's own session, so make that
// the active session first: switch to it if this device holds it,
// otherwise ask for sign-in. Never sign the active profile out.
onMounted(() => {
  if (!email) {
    state.value = 'invalid'
  } else if (target.value && activeProfile.value?.profileId === target.value.profileId) {
    void runVerify()
  } else {
    state.value = target.value ? 'switch' : 'signin'
  }
})

async function switchAndVerify() {
  if (!target.value) return
  pending.value = true
  const result = await enterProfile(target.value.profileId)
  pending.value = false
  if (result.ok) await runVerify()
  else state.value = 'signin'
}

async function runVerify() {
  error.value = ''
  state.value = 'checking'
  const result = await verifyEmail(token)
  if (!result?.error) {
    state.value = 'done'
    // Pull the new status into the profile cache so the picker's badge clears.
    void reconcileDeviceSessions()
  } else if (result.error.status === 403) {
    error.value = 'Sign in to this account to verify its email.'
    state.value = 'signin'
  } else if (result.error.status === 401) {
    state.value = 'invalid'
  } else {
    error.value = 'Something went wrong. Try again.'
    state.value = 'signin'
  }
}

async function sendNewLink() {
  if (!email) return
  pending.value = true
  const result = await sendVerificationEmail(email)
  pending.value = false
  notice.value = emailRequestMessage(result, VERIFY_SENT)
}
</script>

<template>
  <div class="verify">
    <h2>Verify your email</h2>

    <p v-if="state === 'checking'" class="muted">Checking your link…</p>

    <div v-else-if="state === 'switch'" class="card">
      <p>This link is for <strong>{{ email }}</strong>. Switch to that profile to verify it.</p>
      <button type="button" class="submit-btn" :disabled="pending" @click="switchAndVerify">
        Switch and verify
      </button>
    </div>

    <template v-else-if="state === 'signin'">
      <p class="muted">Sign in as <strong>{{ email }}</strong> to finish verifying.</p>
      <p v-if="error" class="error-msg">{{ error }}</p>
      <SignInForm
        :sign-in-social="signInSocial"
        :sign-in-email="signInEmail"
        :sign-up-email="signUpEmail"
        :request-password-reset="requestPasswordReset"
        :reauth="{ email: email ?? '', provider: 'email' }"
        @success="runVerify"
      />
    </template>

    <div v-else-if="state === 'done'" class="card">
      <p>Your address <strong>{{ email }}</strong> is verified.</p>
      <RouterLink to="/home" class="submit-btn">Continue</RouterLink>
    </div>

    <div v-else class="card">
      <p>This link is no longer valid.</p>
      <template v-if="email">
        <p v-if="notice" class="muted" role="status">{{ notice }}</p>
        <button type="button" class="submit-btn" :disabled="pending" @click="sendNewLink">
          Send a new link
        </button>
      </template>
      <p v-else class="muted">Request a new one from account settings.</p>
    </div>
  </div>
</template>

<style scoped>
.verify {
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

.card p,
.muted,
.error-msg {
  margin: 0;
  font-size: 0.9rem;
}

.muted {
  color: var(--color-muted);
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
