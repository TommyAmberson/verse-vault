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
//
// `force: '1'` is load-bearing: the router guard auto-forwards a
// still-`signedIn` user off `/profiles` back to `redirect`, and
// `signedIn` is registry-driven so it stays true after the cookie dies —
// exactly this scenario. Without `force`, the redirect bounces straight
// back and the picker never shows. (Matches AppAvatar / OfflineBanner.)
let redirecting = false
setUnauthorizedHandler(() => {
  const current = router.currentRoute.value
  if (current.name === 'profiles' || redirecting) return
  redirecting = true
  void router
    .push({
      name: 'profiles',
      query: { redirect: current.fullPath, reason: 'expired', force: '1' },
    })
    .catch(() => {})
    .finally(() => {
      redirecting = false
    })
})

createApp(App).use(router).mount('#app')
