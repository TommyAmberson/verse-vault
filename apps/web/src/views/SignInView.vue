<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'

import SignInForm from '@/components/SignInForm.vue'
import { authClient, signInComplete, useAuth } from '@/composables/useAuth'

const { signInSocial, signInEmail, signUpEmail } = useAuth()
const router = useRouter()
const route = useRoute()

async function onSuccess() {
  // The SignInForm emits 'success' once Better Auth has set the
  // cookie. Pull the session so we can give signInComplete a typed
  // user object — Better Auth's reactive ref lags this point by
  // up to a tick, but `getSession()` reads the freshly-cached value
  // synchronously. signInComplete handles registry upsert + legacy
  // DB migration + setting the active profile.
  const result = await authClient.getSession()
  if (result?.data?.user) {
    await signInComplete(result.data.user)
  }
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/review'
  router.replace(redirect)
}
</script>

<template>
  <div class="signin">
    <h2>Sign in</h2>
    <SignInForm
      :sign-in-social="signInSocial"
      :sign-in-email="signInEmail"
      :sign-up-email="signUpEmail"
      @success="onSuccess"
    />
  </div>
</template>

<style scoped>
.signin {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  width: 100%;
  max-width: 22rem;
}

h2 {
  margin: 0;
  font-size: 1.5rem;
}
</style>
