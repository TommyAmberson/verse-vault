import { createRouter, createWebHistory } from 'vue-router'

import { authClient, loadActiveProfileFromRegistry, markOnline } from '@/composables/useAuth'
import { getLastActiveProfileId } from '@/lib/engine/registry'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/review' },
    { path: '/session', redirect: '/review' },
    {
      path: '/signin',
      name: 'signin',
      component: () => import('@/views/SignInView.vue'),
      meta: { public: true },
    },
    {
      path: '/review',
      name: 'review',
      component: () => import('@/views/ReviewView.vue'),
    },
    {
      path: '/memorize',
      name: 'memorize',
      component: () => import('@/views/MemorizeView.vue'),
    },
    {
      path: '/stats',
      name: 'stats',
      component: () => import('@/views/StatsView.vue'),
    },
    {
      path: '/material',
      name: 'material',
      component: () => import('@/views/MaterialView.vue'),
    },
  ],
})

// Cache-first guard. The signed-in/out decision is driven by the
// profile registry on disk, NOT by an awaited `getSession()` call —
// that's the offline-boot fix. The registry tells us "this device
// last used profile X"; we honour that immediately and render the
// workspace from the per-profile IDB cache. The live `getSession()`
// fires unawaited and flips the `isOnline` reactive flag when it
// resolves; the offline banner picks that up.
//
// If the registry has no last-active profile (or the referenced DB
// has been wiped), fall through to the sign-in form.
router.beforeEach(async (to) => {
  await loadActiveProfileFromRegistry()
  const lastActive = await getLastActiveProfileId()
  const signedIn = lastActive != null

  // Kick off the live session check in the background. We don't await
  // it; it just feeds the online/offline indicator via the watcher.
  void authClient
    .getSession()
    .then((result) => markOnline(!!result?.data?.user))
    .catch(() => markOnline(false))

  if (to.meta.public) {
    if (signedIn && to.name === 'signin') {
      const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/review'
      return redirect
    }
    return true
  }
  if (signedIn) return true
  return { name: 'signin', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
})

export default router
