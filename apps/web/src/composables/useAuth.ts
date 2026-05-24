import { computed, ref, watch } from 'vue'

import { createAppAuthClient } from '@/lib/authClient'
import { clearAllSessions } from '@/lib/engine/engineStore'
import { migrateLegacyDb } from '@/lib/engine/migrate-legacy'
import { deleteIdb, profileDbName, setActiveProfile } from '@/lib/engine/persistence'
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

/** Three-state sync status:
 *  - `online`     — most recent sync attempt succeeded with a live session.
 *  - `signed-out` — the server is reachable but rejected the request
 *                   (no cookie / cookie expired). Sign-in will work.
 *  - `offline`    — the network call itself failed; can't sign in until
 *                   connectivity is restored.
 *
 *  Defaults to `online` so the banner doesn't flash on cold boot before
 *  the first attempt resolves. Distinguishing signed-out from offline
 *  drives the banner copy (and lets us NOT misleadingly tell an offline
 *  user to "sign in" as if that would help). */
export type SyncState = 'online' | 'signed-out' | 'offline'
const syncState = ref<SyncState>('online')

interface UserPayload {
  id: string
  email: string
  name?: string
  image?: string | null
}

/** Non-null when Better Auth returns a different user than the
 *  currently-active profile expected. The user picks either Switch
 *  (new account becomes active; old one stays on the device as a
 *  signed-out card) or Stay (revoke the new server-issued token,
 *  leaving the old profile active but stale until a real re-auth). */
interface ConflictState {
  expectedEmail: string
  pendingUser: UserPayload
  pendingSessionToken: string | null
}
const conflict = ref<ConflictState | null>(null)

let activeProfileLoaded = false

function nowSecs(): number {
  return Math.floor(Date.now() / 1000)
}

/** Read the registry on app boot. If a `lastActiveProfileId` is set and
 *  its per-profile DB exists, populate `activeProfile` and tell the
 *  persistence layer to open that DB. If the pointer is stale (DB was
 *  deleted out from under us, etc.), clear it so the router falls back
 *  to the sign-in form. Returns true when the active profile is set
 *  and ready to use, false when the router should redirect to /signin.
 *  Idempotent — repeat calls in the same session short-circuit. */
export async function loadActiveProfileFromRegistry(): Promise<boolean> {
  if (activeProfileLoaded) return activeProfile.value != null
  activeProfileLoaded = true
  const id = await registry.getLastActiveProfileId()
  if (!id) {
    activeProfile.value = null
    return false
  }
  const exists = await registry.profileDbExists(id)
  if (!exists) {
    await registry.setLastActiveProfileId(null)
    activeProfile.value = null
    return false
  }
  const row = await registry.getProfile(id)
  if (!row) {
    await registry.setLastActiveProfileId(null)
    activeProfile.value = null
    return false
  }
  await setActiveProfile(id)
  activeProfile.value = row
  return true
}

/** Update the sync indicator state. Called from the router boot's
 *  background `getSession()` and (eventually) from the engine flush
 *  path so the banner reflects the actual result of the most recent
 *  attempt. */
export function markSyncState(state: SyncState): void {
  syncState.value = state
}

/** Acknowledge + clear a pending conflict. UI calls this after the
 *  user picks a resolution. */
export function clearConflict(): void {
  conflict.value = null
}

function takePendingConflict(): ConflictState | null {
  const pending = conflict.value
  conflict.value = null
  return pending
}

/** Accept the new user: replace the active profile (old stays as a
 *  signed-out card) and re-run signInComplete past the conflict guard. */
export async function acceptPendingSignIn(): Promise<void> {
  const pending = takePendingConflict()
  if (!pending) return
  if (activeProfile.value) {
    await setProfileToken(activeProfile.value.profileId, null)
  }
  activeProfile.value = null
  activeProfileLoaded = false
  await signInComplete(pending.pendingUser, pending.pendingSessionToken)
}

/** Decline the new session: revoke its token, keep the previous active
 *  profile (typically stale — that's what triggered the re-auth). */
export async function cancelPendingSignIn(): Promise<void> {
  const pending = takePendingConflict()
  if (!pending) return
  if (pending.pendingSessionToken) {
    try {
      await authClient.multiSession.revoke({
        sessionToken: pending.pendingSessionToken,
      })
    } catch {
      // Best-effort; the token expires server-side eventually.
    }
  }
  // Re-pin the prior active profile as Better Auth's current session
  // cookie. multiSession.revoke clears the server-side token but
  // doesn't repoint the cookie, so without this getSession() would
  // return null and the workspace would think the user is signed out.
  if (activeProfile.value?.sessionToken) {
    try {
      await authClient.multiSession.setActive({
        sessionToken: activeProfile.value.sessionToken,
      })
    } catch {
      // If repinning fails the next getSession will mark us signed-out.
    }
  }
}

/** Wraps `registry.updateProfileSessionToken` and mirrors the change
 *  into `activeProfile.value` when the target is the active profile,
 *  so callers don't repeat the if-active-then-refresh dance. */
async function setProfileToken(
  profileId: string,
  sessionToken: string | null,
): Promise<void> {
  const updated = await registry.updateProfileSessionToken(profileId, sessionToken)
  if (updated && activeProfile.value?.profileId === profileId) {
    activeProfile.value = updated
  }
}

/** Run after a successful Better Auth sign-in / sign-up. Upserts the
 *  profile in the registry, runs the legacy-DB migration when this is
 *  the device's first-ever profile, and opens the per-profile DB so
 *  the workspace can render. Idempotent on re-entry with the same
 *  user; surfaces `conflict` and returns early when the session user
 *  doesn't match the currently-active profile. */
export async function signInComplete(
  user: {
    id: string
    email: string
    name?: string
    image?: string | null
  },
  sessionToken: string | null = null,
): Promise<void> {
  const existing = await registry.getProfile(user.id)

  // Capture the pending payload so the resolver can re-enter without
  // a second server round-trip.
  if (activeProfile.value && activeProfile.value.profileId !== user.id) {
    conflict.value = {
      expectedEmail: activeProfile.value.email,
      pendingUser: user,
      pendingSessionToken: sessionToken,
    }
    return
  }

  // Read this BEFORE the upsert so the migration gate sees the
  // pre-state (no profiles yet = this is the device's first-ever
  // sign-in post-PR-A = legacy `verse-vault` data should be adopted
  // into this user's profile DB). Gating on per-user `isNew` would
  // be a footgun: if user A's first sign-in failed mid-migration and
  // left the legacy DB on disk, user B signing in later would inherit
  // A's data into B's profile.
  const isFirstEverProfile = (await registry.listProfiles()).length === 0

  const now = nowSecs()
  const row: registry.ProfileRow = {
    profileId: user.id,
    email: user.email,
    displayName: user.name ?? user.email,
    image: user.image ?? null,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
    // Prefer the freshly-issued token; fall back to whatever was on
    // the existing row so a re-entry without a new token (e.g. an
    // idempotent watcher fire) doesn't blow away a valid stored one.
    sessionToken: sessionToken ?? existing?.sessionToken ?? null,
  }
  await registry.upsertProfile(row)
  await registry.setLastActiveProfileId(user.id)

  // Switch the persistence layer to the new profile's DB before any
  // migration so the eager open creates all stores.
  clearAllSessions()
  await setActiveProfile(user.id)

  if (isFirstEverProfile) {
    try {
      await migrateLegacyDb(user.id)
    } catch (err) {
      console.warn('legacy DB migration failed; continuing:', err)
    }
  }

  activeProfile.value = row
  syncState.value = 'online'
}

export type EnterResult = { ok: boolean }

/** Switch the in-memory + persistence-layer active profile to
 *  `profileId`. Calls `multiSession.setActive` first so Better Auth
 *  treats the stored token as the current session. Returns `ok: false`
 *  when the row has no token or the server rejects it, so the caller
 *  can route to the sign-in form. Network errors during setActive
 *  fall through — the IDB cache is offline-usable; sync resumes when
 *  connectivity returns. Does NOT navigate. */
export async function enterProfile(profileId: string): Promise<EnterResult> {
  const row = await registry.getProfile(profileId)
  if (!row) throw new Error(`enterProfile: no registry row for ${profileId}`)
  if (!row.sessionToken) return { ok: false }

  try {
    const result = await authClient.multiSession.setActive({
      sessionToken: row.sessionToken,
    })
    if (result?.error) {
      await setProfileToken(profileId, null)
      return { ok: false }
    }
  } catch {
    // Offline — enter the cached profile anyway.
  }

  clearAllSessions()
  await setActiveProfile(profileId)

  const touched: registry.ProfileRow = { ...row, lastUsedAt: nowSecs() }
  await registry.upsertProfile(touched)
  await registry.setLastActiveProfileId(profileId)
  activeProfile.value = touched
  return { ok: true }
}

/** Permanently remove a profile from this device: revoke its server
 *  session, drop its registry row, drop its per-profile IDB DB. If
 *  the deleted profile is the currently-active one, also clear
 *  in-memory engine state and the `lastActiveProfileId` pointer (so
 *  the next render sees no active profile — the picker stays put
 *  rather than auto-redirecting). */
export async function deleteProfile(profileId: string): Promise<void> {
  const wasActive = activeProfile.value?.profileId === profileId
  const row = await registry.getProfile(profileId)

  if (row?.sessionToken) {
    try {
      await authClient.multiSession.revoke({ sessionToken: row.sessionToken })
    } catch {
      // Best-effort; the token expires server-side eventually.
    }
  }

  if (wasActive) {
    clearAllSessions()
    await setActiveProfile(null)
    await registry.setLastActiveProfileId(null)
    activeProfile.value = null
    activeProfileLoaded = false
  }

  await registry.removeProfile(profileId)

  // Active profile's connection was closed via `setActiveProfile(null)`
  // above; non-active profiles never had one open. `deleteIdb`
  // resolves on `onblocked` rather than hanging — a holding tab is a
  // "try again later" scenario, not a failure.
  await deleteIdb(profileDbName(profileId))
}

/** Sign out a profile by revoking its server-side session and clearing
 *  its stored token. Defaults to the active profile when no id is
 *  given. Profile + IDB stay intact — sign-out is the "I'll be back"
 *  action; permanent removal is `deleteProfile()`. Active-target also
 *  clears in-memory state so the picker takes over; non-active just
 *  flips the chip. */
export async function signOut(targetProfileId?: string): Promise<void> {
  const targetId = targetProfileId ?? activeProfile.value?.profileId ?? null
  if (!targetId) return

  const row = await registry.getProfile(targetId)
  if (!row) return
  if (row.sessionToken) {
    try {
      await authClient.multiSession.revoke({ sessionToken: row.sessionToken })
    } catch {
      // Cookie still flips locally; server token will expire on its own.
    }
  }
  await registry.upsertProfile({ ...row, sessionToken: null })

  if (activeProfile.value?.profileId === targetId) {
    await registry.setLastActiveProfileId(null)
    await setActiveProfile(null)
    clearAllSessions()
    activeProfile.value = null
    // Reset the load-once flag so the next sign-in re-reads the
    // registry — keeps the "flag true ⟺ registry consulted this
    // session for the current profile" invariant honest.
    activeProfileLoaded = false
    syncState.value = 'signed-out'
  }
}

// OAuth leaves the page for the IdP redirect, so when the app
// re-mounts after the callback there's no in-flight Promise to chain
// `signInComplete` onto. Watch the reactive session instead and run
// it on user-change; also keep the stored token fresh when the server
// rotates a cookie under the existing user.
const sessionWatchRef = authClient.useSession()
watch(
  () => sessionWatchRef.value.data,
  (data) => {
    const user = data?.user
    if (!user) return
    const sessionToken = data?.session?.token ?? null
    if (activeProfile.value?.profileId === user.id) {
      if (sessionToken && activeProfile.value.sessionToken !== sessionToken) {
        void setProfileToken(user.id, sessionToken)
      }
      return
    }
    void signInComplete(user, sessionToken)
  },
)

/** Ask the server which device sessions are still alive and clear
 *  stored tokens on any registry row whose token isn't in the
 *  response. Fire-and-forget from the router boot; the picker reads
 *  `listProfiles()` on mount so reconcile results show up the next
 *  time the user navigates to `/profiles`. */
export async function reconcileDeviceSessions(): Promise<void> {
  try {
    const result = await authClient.multiSession.listDeviceSessions()
    const sessions = result?.data ?? []
    const liveTokens = new Set(
      sessions
        .map((entry: { session?: { token?: string } }) => entry.session?.token)
        .filter((t): t is string => typeof t === 'string'),
    )
    const profiles = await registry.listProfiles()
    const stale = profiles.filter(
      (p) => p.sessionToken && !liveTokens.has(p.sessionToken),
    )
    await Promise.all(stale.map((p) => setProfileToken(p.profileId, null)))
  } catch {
    // Offline — leave stored tokens alone; next boot will retry.
  }
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
    if (user) await signInComplete(user, extractSessionToken(result))
    return result
  }

  async function signUpEmail(email: string, password: string) {
    const result = await factoryShape.signUpEmail(email, password)
    const user = extractUser(result)
    if (user) await signInComplete(user, extractSessionToken(result))
    return result
  }

  return {
    session: factoryShape.session,
    signInSocial: factoryShape.signInSocial,
    signInEmail,
    signUpEmail,
    activeProfile: computed(() => activeProfile.value),
    syncState: computed(() => syncState.value),
    isOnline: computed(() => syncState.value === 'online'),
    conflict: computed(() => conflict.value),
    signOut,
    signInComplete,
    enterProfile,
    deleteProfile,
    markSyncState,
    clearConflict,
    acceptPendingSignIn,
    cancelPendingSignIn,
  }
}

interface SignInData {
  user?: UserPayload
  token?: string | null
  session?: { token?: string | null } | null
}

function extractUser(result: unknown): UserPayload | null {
  return readData(result)?.user ?? null
}

// Better Auth surfaces the session token at `data.token` for email/
// password; some plugin paths put it under `data.session.token`.
function extractSessionToken(result: unknown): string | null {
  const data = readData(result)
  return data?.token ?? data?.session?.token ?? null
}

function readData(result: unknown): SignInData | null {
  if (!result || typeof result !== 'object') return null
  const data = (result as { data?: unknown }).data
  return data && typeof data === 'object' ? (data as SignInData) : null
}
