<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import SignInForm from '@/components/SignInForm.vue'
import { useAuth } from '@/composables/useAuth'
import { useEmailRequest } from '@/composables/useEmailRequest'
import { VERIFY_SENT } from '@/lib/authEmail'

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
// The emailed link names its account so this page knows whom to sign in;
// the server checks the token and the session regardless.
const email = typeof route.query.email === 'string' ? route.query.email : ''
const state = ref<'checking' | 'switch' | 'signin' | 'done' | 'invalid'>('checking')
const error = ref('')
const pending = ref(false)
const {
  pending: newLinkPending,
  notice: newLinkNotice,
  run: sendNewLink,
} = useEmailRequest(
  () => sendVerificationEmail(email),
  () => VERIFY_SENT,
)

// A profile on this device that is signed in as the link's address.
const target = computed(() =>
  profiles.value.find(
    (p) => p.sessionToken !== null && p.email.toLowerCase() === email.toLowerCase(),
  ),
)

// The server verifies only for the account's own session, so make that
// the active session first: switch to it if this device holds it,
// otherwise ask for sign-in. Never sign the active profile out.
onMounted(() => {
  if (!token || !email) {
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
    // Better Auth refetches the session after verifying, and the session
    // watcher in useAuth copies the new status onto the profile row.
    state.value = 'done'
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
</script>

<template>
  <div class="verify">
    <h2>Verify your email</h2>

    <p v-if="state === 'checking'" class="auth-notice">Checking your link…</p>

    <div v-else-if="state === 'switch'" class="auth-card">
      <p>This link is for <strong>{{ email }}</strong>. Switch to that profile to verify it.</p>
      <button type="button" class="auth-submit" :disabled="pending" @click="switchAndVerify">
        Switch and verify
      </button>
    </div>

    <template v-else-if="state === 'signin'">
      <p class="auth-notice">Sign in as <strong>{{ email }}</strong> to finish verifying.</p>
      <p v-if="error" class="auth-error">{{ error }}</p>
      <SignInForm
        :sign-in-social="signInSocial"
        :sign-in-email="signInEmail"
        :sign-up-email="signUpEmail"
        :request-password-reset="requestPasswordReset"
        :reauth="{ email, provider: 'email' }"
        @success="runVerify"
      />
    </template>

    <div v-else-if="state === 'done'" class="auth-card">
      <p>Your address <strong>{{ email }}</strong> is verified.</p>
      <RouterLink to="/home" class="auth-submit">Continue</RouterLink>
    </div>

    <div v-else class="auth-card">
      <p>This link is no longer valid.</p>
      <template v-if="email">
        <p v-if="newLinkNotice" class="auth-notice" role="status">{{ newLinkNotice }}</p>
        <button type="button" class="auth-submit" :disabled="newLinkPending" @click="sendNewLink">
          Send a new link
        </button>
      </template>
      <p v-else class="auth-notice">Request a new one from account settings.</p>
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
</style>
