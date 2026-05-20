import { createRouter, createWebHistory } from 'vue-router'

import { authClient } from '@/composables/useAuth'

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

// Read the signed-in state directly from `getSession()`'s return value
// rather than from `useSession()`'s reactive ref. The reactive ref runs
// its own async fetch and lags behind both (a) the initial cookie that
// a hard refresh re-presents and (b) the just-set cookie that signIn
// produces — so a synchronous read against it would bounce a real user
// to /signin. `getSession()` always reflects the canonical state at the
// moment of the await; Better Auth caches it internally so per-nav
// fetches are cheap.
router.beforeEach(async (to) => {
  const result = await authClient.getSession()
  const signedIn = !!result?.data?.user
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
