<script setup lang="ts">
import { useRouter } from 'vue-router'

import SignInForm from '@/components/SignInForm.vue'
import { useAuth } from '@/composables/useAuth'

// Reset emails sent before 2b linked here; emails now carry a code, which
// the sign-in form's "Forgot password?" takes.
const {
  signInSocial,
  signInEmail,
  signUpEmail,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  sendVerificationCode,
} = useAuth()
const router = useRouter()
</script>

<template>
  <div class="reset">
    <h2>Reset your password</h2>
    <p class="auth-notice">Emails now carry a code instead of a link. Ask for one here.</p>
    <SignInForm
      forgot
      :sign-in-social="signInSocial"
      :sign-in-email="signInEmail"
      :sign-up-email="signUpEmail"
      :request-password-reset="requestPasswordReset"
      :reset-password="resetPassword"
      :verify-email="verifyEmail"
      :send-verification-code="sendVerificationCode"
      @success="router.push('/home')"
    />
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
