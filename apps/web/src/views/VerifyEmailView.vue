<template>
  <!-- Verification emails sent before 2b linked here; emails now carry a
       code, which account settings sends and takes. -->
  <div class="verify">
    <h2>Verify your email</h2>
    <div class="auth-card">
      <p>Emails now carry a code instead of a link.</p>
      <p class="auth-notice">Sign in, then send a verification code from account settings.</p>
      <RouterLink to="/settings/account" class="auth-submit">Account settings</RouterLink>
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
