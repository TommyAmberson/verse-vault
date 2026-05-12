import { createRouter, createWebHistory } from 'vue-router'

import { authClient, useAuth } from '@/composables/useAuth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/session' },
    {
      path: '/signin',
      name: 'signin',
      component: () => import('@/views/SignInView.vue'),
      meta: { public: true },
    },
    {
      path: '/session',
      name: 'session',
      component: () => import('@/views/SessionView.vue'),
    },
    {
      path: '/stats',
      name: 'stats',
      component: () => import('@/views/StatsView.vue'),
    },
  ],
})

// Better Auth's `useSession()` issues an async fetch; on the very first
// navigation (e.g. after a hard refresh) the reactive session is still
// `{ data: null, isPending: true }`, so a guard that reads `data.user`
// synchronously would bounce a signed-in user to /signin. Cache the
// initial `getSession()` promise and await it once before the guard
// makes a decision — subsequent navigations resolve instantly off the
// already-populated reactive session.
let initialSession: Promise<unknown> | null = null

router.beforeEach(async (to) => {
  initialSession ??= authClient.getSession()
  await initialSession
  const { session } = useAuth()
  const signedIn = !!session.value?.data?.user
  if (to.meta.public) {
    if (signedIn && to.name === 'signin') {
      const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/session'
      return redirect
    }
    return true
  }
  if (signedIn) return true
  return { name: 'signin', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
})

export default router
