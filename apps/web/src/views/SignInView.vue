<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'

import SignInForm from '@/components/SignInForm.vue'
import { useAuth } from '@/composables/useAuth'

const { signInSocial, signInEmail, signUpEmail } = useAuth()
const router = useRouter()
const route = useRoute()

function onSuccess() {
  // useAuth's wrapped signInEmail/signUpEmail have already called
  // signInComplete by the time this fires — registry is populated +
  // the active profile DB is open. Just navigate.
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/review'
  void router.replace(redirect)
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
