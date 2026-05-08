import { createRouter, createWebHistory } from 'vue-router'

import { useAuth } from '@/composables/useAuth'

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

router.beforeEach((to) => {
  if (to.meta.public) return true
  const { session } = useAuth()
  // session.value.data is the live Better Auth session; null when signed out.
  if (session.value?.data?.user) return true
  return { name: 'signin', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} }
})

export default router
