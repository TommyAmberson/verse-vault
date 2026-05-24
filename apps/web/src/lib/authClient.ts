import { multiSessionClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/vue'

/** Mirrors qzr-sheet's `createAppAuthClient` factory: a `createAuthClient`
 *  bound to a base URL plus a `useAuth` composable that exposes the
 *  reactive session and the action verbs the UI needs. Skipping GitHub
 *  for now — Google + email/password only.
 *
 *  `multiSessionClient` mirrors the server-side `multiSession()` plugin
 *  and surfaces `authClient.multiSession.{listDeviceSessions, setActive,
 *  revoke}` for the picker. */

export type SocialProvider = 'google'

export function createAppAuthClient(baseURL: string) {
  const authClient = createAuthClient({
    baseURL,
    plugins: [multiSessionClient()],
  })

  function useAuth() {
    const session = authClient.useSession()

    function signInSocial(provider: SocialProvider) {
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
