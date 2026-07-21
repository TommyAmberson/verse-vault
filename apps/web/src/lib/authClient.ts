import { multiSessionClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/vue'

import type { AuthProvider } from '@/lib/engine/registry'

/** Mirrors qzr-sheet's `createAppAuthClient` factory: a `createAuthClient`
 *  bound to a base URL plus a `useAuth` composable that exposes the
 *  reactive session and the action verbs the UI needs. Skipping GitHub
 *  for now — Google + email/password only.
 *
 *  `multiSessionClient` mirrors the server-side `multiSession()` plugin
 *  and surfaces `authClient.multiSession.{listDeviceSessions, setActive,
 *  revoke}` for the picker. */

export type SocialProvider = 'google'

// Social sign-in leaves the page for the OAuth redirect, so the provider
// we knew at click time is gone by the time the session watcher runs
// `signInComplete` on return. Stash it in sessionStorage across the
// round-trip; the watcher reads-and-clears it to stamp the profile row.
const PENDING_PROVIDER_KEY = 'vv:pendingProvider'

function stashPendingProvider(provider: AuthProvider): void {
  try {
    sessionStorage.setItem(PENDING_PROVIDER_KEY, provider)
  } catch {
    // Private-mode / storage-disabled: the profile just won't record the
    // provider this round; re-auth falls back to the email form.
  }
}

/** Read and clear the provider stashed before an OAuth redirect. Returns
 *  `undefined` when there was none (a restored session, not a fresh
 *  social sign-in). */
export function readPendingProvider(): AuthProvider | undefined {
  try {
    const v = sessionStorage.getItem(PENDING_PROVIDER_KEY)
    if (v) {
      sessionStorage.removeItem(PENDING_PROVIDER_KEY)
      return v as AuthProvider
    }
  } catch {
    // ignore
  }
  return undefined
}

export function createAppAuthClient(baseURL: string) {
  const authClient = createAuthClient({
    baseURL,
    plugins: [multiSessionClient()],
  })

  function useAuth() {
    const session = authClient.useSession()

    function signInSocial(provider: SocialProvider) {
      stashPendingProvider(provider)
      authClient.signIn.social({ provider, callbackURL: window.location.href })
    }

    async function signInEmail(email: string, password: string) {
      return authClient.signIn.email({ email, password, callbackURL: window.location.href })
    }

    async function signUpEmail(email: string, password: string) {
      return authClient.signUp.email({
        email,
        password,
        name: email,
        callbackURL: window.location.href,
      })
    }

    function signOut() {
      authClient.signOut()
    }

    return { session, signInSocial, signInEmail, signUpEmail, signOut }
  }

  return { authClient, useAuth }
}
