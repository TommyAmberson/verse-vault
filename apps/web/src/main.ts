import { createApp } from 'vue'

import './assets/colors.css'
import { setUnauthorizedHandler } from './api'
import App from './App.vue'
import router from './router'

// Session cookie died mid-session (expired / revoked) while a local
// profile is still active: redirect to the profile picker to re-auth
// rather than leaving the view on an error banner. `redirecting` guards
// the burst of concurrent 401s a multi-material view fires from stacking
// duplicate navigations; the picker skips it once we're already there.
let redirecting = false
setUnauthorizedHandler(() => {
  const current = router.currentRoute.value
  if (current.name === 'profiles' || redirecting) return
  redirecting = true
  void router
    .push({ name: 'profiles', query: { redirect: current.fullPath, reason: 'expired' } })
    .catch(() => {})
    .finally(() => {
      redirecting = false
    })
})

createApp(App).use(router).mount('#app')
