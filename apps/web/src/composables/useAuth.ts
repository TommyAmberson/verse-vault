import { computed, ref } from 'vue'

import { createAppAuthClient } from '@/lib/authClient'
import { clearAllSessions } from '@/lib/engine/engineStore'
import { migrateLegacyDb } from '@/lib/engine/migrate-legacy'
import { setActiveProfile } from '@/lib/engine/persistence'
import * as registry from '@/lib/engine/registry'

// Better Auth's client auto-appends `/api/auth` to baseURL only when the
// URL has no path component (see `withPath` / `checkHasPath` in
// better-auth/utils/url). In our subpath deployment VITE_API_BASE is `/vv`,
// which already has a path, so the auto-append is skipped — we add the
// `/api/auth` suffix ourselves. Better Auth also validates baseURL via
// `new URL(...)`, which rejects relative inputs, so we absolutize against
// `window.location.origin` when VITE_API_BASE is origin-relative.
// VITE_API_URL is the legacy absolute-origin form, kept as a fallback.
const apiBase =
  import.meta.env.VITE_API_BASE ??
  import.meta.env.VITE_API_URL ??
  'http://localhost:3000'
const authBaseURL = apiBase.startsWith('/')
  ? `${window.location.origin}${apiBase}/api/auth`
  : `${apiBase}/api/auth`

const { authClient, useAuth: useAuthFactory } = createAppAuthClient(authBaseURL)

export { authClient }

// --- Profile-aware module-level state -----------------------------------------

/** The currently-active profile, or null when no profile is loaded
 *  (boot before registry-read; sign-out; first-ever launch). */
const activeProfile = ref<registry.ProfileRow | null>(null)

/** True when the most recent sync attempt (or session check) succeeded.
 *  Drives the offline banner. Defaults true so the banner doesn't flash
 *  on cold boot before the first attempt resolves; flipped to false on
 *  any failure, back to true on the next success. */
const isOnline = ref<boolean>(true)

/** Non-null when Better Auth returns a different user than the
 *  currently-active profile expected. The workspace surfaces this so
 *  the user can pick: sign out, or add the new user as a profile. */
const conflict = ref<{ expectedEmail: string; actualEmail: string } | null>(null)

let activeProfileLoaded = false

function nowSecs(): number {
  return Math.floor(Date.now() / 1000)
}

/** Read the registry on app boot. If a `lastActiveProfileId` is set and
 *  its per-profile DB exists, populate `activeProfile` and tell the
 *  persistence layer to open that DB. If the pointer is stale (DB was
 *  deleted out from under us, etc.), clear it so the router falls back
 *  to the sign-in form. */
export async function loadActiveProfileFromRegistry(): Promise<void> {
  if (activeProfileLoaded) return
  activeProfileLoaded = true
  const id = await registry.getLastActiveProfileId()
  if (!id) {
    activeProfile.value = null
    return
  }
  const exists = await registry.profileDbExists(id)
  if (!exists) {
    await registry.setLastActiveProfileId(null)
    activeProfile.value = null
    return
  }
  const row = await registry.getProfile(id)
  if (!row) {
    await registry.setLastActiveProfileId(null)
    activeProfile.value = null
    return
  }
  await setActiveProfile(id)
  activeProfile.value = row
}

/** Mark the active profile as online (sync succeeded) or offline
 *  (sync failed for any reason). Called by the engine flush path and
 *  by anything else that wants to nudge the indicator. */
export function markOnline(online: boolean): void {
  isOnline.value = online
}

/** Acknowledge + clear a pending conflict. UI calls this after the
 *  user picks a resolution. */
export function clearConflict(): void {
  conflict.value = null
}

/** Called by `SignInView` after a successful Better Auth sign-in. We
 *  upsert the profile in the registry, run the legacy-DB migration if
 *  this is the first profile we've ever created, and open the
 *  per-profile DB so the workspace can render. */
export async function signInComplete(user: {
  id: string
  email: string
  name?: string
  image?: string | null
}): Promise<void> {
  const existing = await registry.getProfile(user.id)

  // Conflict: user re-authed but came back as someone else. Leave the
  // active profile alone; the UI reads `conflict` and prompts.
  if (activeProfile.value && activeProfile.value.profileId !== user.id) {
    conflict.value = {
      expectedEmail: activeProfile.value.email,
      actualEmail: user.email,
    }
    return
  }

  const now = nowSecs()
  const isNew = existing == null
  const row: registry.ProfileRow = {
    profileId: user.id,
    email: user.email,
    displayName: user.name ?? user.email,
    image: user.image ?? null,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  }
  await registry.upsertProfile(row)
  await registry.setLastActiveProfileId(user.id)

  // Switch the persistence layer to the new profile's DB before any
  // migration so the eager open creates all stores.
  clearAllSessions()
  await setActiveProfile(user.id)

  if (isNew) {
    try {
      await migrateLegacyDb(user.id)
    } catch (err) {
      console.warn('legacy DB migration failed; continuing:', err)
    }
  }

  activeProfile.value = row
  isOnline.value = true
}

/** Sign out the current profile. Best-effort API call to invalidate
 *  the server session; local state is cleared regardless. The profile
 *  + its IDB DB stay intact — sign-out is the "I'll be back" action.
 *  Permanent removal is `removeActiveProfile()` (future PR B). */
export async function signOut(): Promise<void> {
  try {
    await authClient.signOut()
  } catch {
    // Offline / 401 / anything — fine. We still clear local state.
  }
  await registry.setLastActiveProfileId(null)
  await setActiveProfile(null)
  clearAllSessions()
  activeProfile.value = null
  isOnline.value = false
}

// --- Composable surface -------------------------------------------------------

/** The Vue composable retained from qzr-sheet's pattern. Exposes the
 *  reactive session, profile state, online flag, conflict ref, plus
 *  the sign-in / sign-up action verbs.
 *
 *  Email/password sign-in returns the user inline in the Better Auth
 *  response; we wrap the factory's verbs to call `signInComplete`
 *  with that user before resolving — saves the caller a separate
 *  `getSession()` roundtrip that races the cookie-set anyway.
 *  Social sign-in goes through an OAuth redirect, so the
 *  registry-upsert path for that case runs from a watcher on the
 *  reactive session below. */
export function useAuth() {
  const factoryShape = useAuthFactory()

  async function signInEmail(email: string, password: string) {
    const result = await factoryShape.signInEmail(email, password)
    const user = extractUser(result)
    if (user) await signInComplete(user)
    return result
  }

  async function signUpEmail(email: string, password: string) {
    const result = await factoryShape.signUpEmail(email, password)
    const user = extractUser(result)
    if (user) await signInComplete(user)
    return result
  }

  return {
    // Better Auth reactive session (pending / data / error).
    session: factoryShape.session,
    // Sign-in / sign-up verbs — wrapped to run signInComplete.
    signInSocial: factoryShape.signInSocial,
    signInEmail,
    signUpEmail,
    // Profile-aware additions.
    activeProfile: computed(() => activeProfile.value),
    isOnline: computed(() => isOnline.value),
    conflict: computed(() => conflict.value),
    signOut,
    signInComplete,
    markOnline,
    clearConflict,
  }
}

interface UserPayload {
  id: string
  email: string
  name?: string
  image?: string | null
}

function extractUser(
  result: { data?: { user?: UserPayload } | null } | undefined,
): UserPayload | null {
  return result?.data?.user ?? null
}
