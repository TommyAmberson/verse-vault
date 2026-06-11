import { createRouter, createWebHistory } from 'vue-router'

import {
  authClient,
  loadActiveProfileFromRegistry,
  markSyncState,
  reconcileDeviceSessions,
} from '@/composables/useAuth'

let reconcileFired = false

/** A `?redirect=` query parameter is attacker-controllable — guard against
 *  external URLs and protocol-relative `//evil.com` paths. Only
 *  same-origin SPA paths (starting with a single `/`) are honoured;
 *  anything else falls back to the default landing route. */
function safeRedirect(raw: unknown): string {
  if (typeof raw !== 'string') return '/home'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/home'
  return raw
}

export { safeRedirect }

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/home' },
    { path: '/session', redirect: '/review' },
    { path: '/signin', redirect: '/profiles' },
    { path: '/material', redirect: '/settings' },
    { path: '/dashboard', redirect: '/home' },
    {
      path: '/profiles',
      name: 'profiles',
      component: () => import('@/views/ProfilePickerView.vue'),
      meta: { public: true },
    },
    {
      path: '/home',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
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
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
  ],
})

// Cache-first guard. The signed-in/out decision is driven by the
// profile registry on disk, NOT by an awaited `getSession()` call —
// that's the offline-boot fix. The registry tells us "this device
// last used profile X"; we honour that immediately and render the
// workspace from the per-profile IDB cache. The live `getSession()`
// fires unawaited and flips the `syncState` reactive flag when it
// resolves; the offline banner picks that up.
//
// If the registry has no last-active profile (or the referenced DB
// has been wiped), fall through to the sign-in form.
router.beforeEach(async (to) => {
  const signedIn = await loadActiveProfileFromRegistry()

  // Kick off the live session check in the background. We don't await
  // it; it just feeds the sync-state indicator. Four-way outcome:
  //  - resolved with a user                       → online
  //  - resolved without a user, no error          → signed-out (cookie expired or never set)
  //  - resolved with a 429 error                  → rate-limited (server is up, just throttling us)
  //  - rejected (or any other resolved error)     → offline (couldn't reach the server)
  // The rate-limited branch lets the banner show a calmer "wait a
  // moment" message instead of misleadingly telling the user they're
  // offline when they have wifi.
  void authClient
    .getSession()
    .then((result) => {
      if (result?.error?.status === 429) {
        markSyncState('rate-limited')
      } else if (result?.error) {
        markSyncState('offline')
      } else {
        markSyncState(result?.data?.user ? 'online' : 'signed-out')
      }
    })
    .catch(() => markSyncState('offline'))

  // Reconcile stored multi-session tokens against the server once per
  // app launch, not on every navigation — it's a network roundtrip
  // plus per-stale-row IDB writes. First boot wins; subsequent
  // navigations rely on the watcher to keep the active profile fresh.
  if (!reconcileFired) {
    reconcileFired = true
    void reconcileDeviceSessions()
  }

  if (to.meta.public) {
    if (signedIn && to.name === 'profiles' && to.query.force !== '1') {
      return safeRedirect(to.query.redirect)
    }
    return true
  }
  if (signedIn) return true
  return { name: 'profiles', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
})

export default router
