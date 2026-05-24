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

  // Conflict: user re-authed but came back as someone else. Leave the
  // active profile alone; the UI reads `conflict` and prompts.
  if (activeProfile.value && activeProfile.value.profileId !== user.id) {
    conflict.value = {
      expectedEmail: activeProfile.value.email,
      actualEmail: user.email,
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

/** Outcome of an attempt to enter a profile. Callers branch on
 *  `ok: false` to route the user to re-auth instead of the workspace. */
export type EnterResult =
  | { ok: true }
  | { ok: false; reason: 'no-token' | 'token-rejected' }

/** Switch the in-memory + persistence-layer active profile to
 *  `profileId`. Calls `multiSession.setActive` first so Better Auth
 *  treats the stored token as the current session; if the row has no
 *  token (signed-out profile) or the server rejects it (revoked),
 *  returns `ok: false` and the caller routes to the sign-in form
 *  instead of the workspace. Does NOT navigate — the caller
 *  (ProfilePickerView) handles routing. */
export async function enterProfile(profileId: string): Promise<EnterResult> {
  const row = await registry.getProfile(profileId)
  if (!row) throw new Error(`enterProfile: no registry row for ${profileId}`)
  if (!row.sessionToken) return { ok: false, reason: 'no-token' }

  try {
    const result = await authClient.multiSession.setActive({
      sessionToken: row.sessionToken,
    })
    if (result?.error) {
      await registry.updateProfileSessionToken(profileId, null)
      return { ok: false, reason: 'token-rejected' }
    }
  } catch {
    // Network error / offline — fall through and enter the cached
    // profile anyway. The IDB cache still works; sync resumes when
    // the network returns.
  }

  clearAllSessions()
  await setActiveProfile(profileId)

  const updated = await registry.touchProfile(profileId, nowSecs())
  if (!updated) throw new Error(`enterProfile: no registry row for ${profileId}`)
  await registry.setLastActiveProfileId(profileId)

  activeProfile.value = updated
  // Don't touch syncState here — entering a profile doesn't tell us
  // anything about session validity. The router boot's background
  // getSession() will flip it within the next tick.
  return { ok: true }
}

/** Permanently remove a profile from this device: drop its registry
 *  row AND its per-profile IDB DB. If the deleted profile is the
 *  currently-active one, also clear in-memory engine state and the
 *  `lastActiveProfileId` pointer (so the next render sees no active
 *  profile — the picker stays put rather than auto-redirecting). */
export async function deleteProfile(profileId: string): Promise<void> {
  const wasActive = activeProfile.value?.profileId === profileId

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
 *  action; permanent removal is `deleteProfile()`.
 *
 *  When the target is the active profile, also clears the in-memory
 *  active state + lastActiveProfileId so the next render falls back
 *  to the picker. When the target is a non-active profile, just
 *  revokes its token and flips the chip — the active workspace is
 *  untouched. */
export async function signOut(targetProfileId?: string): Promise<void> {
  const targetId = targetProfileId ?? activeProfile.value?.profileId ?? null
  if (!targetId) return

  const row = await registry.getProfile(targetId)
  if (row?.sessionToken) {
    try {
      await authClient.multiSession.revoke({ sessionToken: row.sessionToken })
    } catch {
      // Offline / 401 / anything — fine. We still clear local state
      // so the chip flips and the cookie won't be reused next boot.
    }
  }
  await registry.updateProfileSessionToken(targetId, null)

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

// Watcher: Better Auth's reactive session is the source of truth for
// the OAuth (social) sign-in path. Email/password goes through the
// wrapped `signInEmail` / `signUpEmail` verbs which call
// `signInComplete` inline — but OAuth leaves the page for the IdP
// redirect, so when the app re-mounts after the callback there's no
// in-flight Promise to chain `signInComplete` onto. Instead we watch
// the session ref: when a user appears that doesn't match the active
// profile, run `signInComplete` to upsert the profile, swap the
// per-profile DB, and migrate the legacy DB if needed. Idempotent —
// no-ops if `activeProfile` already matches the session user. Also
// keeps the stored sessionToken fresh for the active profile when the
// server rotates it (cookie refresh, etc.).
const sessionWatchRef = authClient.useSession()
watch(
  () => sessionWatchRef.value.data,
  (data) => {
    const user = data?.user
    if (!user) return
    const sessionToken = data?.session?.token ?? null
    if (activeProfile.value?.profileId === user.id) {
      // Same user as the active profile; just refresh the stored
      // token if it changed (no DB swap, no migration).
      if (sessionToken && activeProfile.value.sessionToken !== sessionToken) {
        void registry
          .updateProfileSessionToken(user.id, sessionToken)
          .then((row) => {
            if (row) activeProfile.value = row
          })
      }
      return
    }
    void signInComplete(user, sessionToken)
  },
)

/** Background reconcile: ask the server which device sessions are
 *  still alive, then clear stored sessionTokens on any registry row
 *  whose token isn't in the response. Called from the router boot —
 *  fire-and-forget, never throws. The picker reads `listProfiles()`
 *  on mount so reconcile results show up the next time the user
 *  navigates to `/profiles`. */
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
    for (const p of profiles) {
      if (p.sessionToken && !liveTokens.has(p.sessionToken)) {
        const updated = await registry.updateProfileSessionToken(p.profileId, null)
        if (updated && activeProfile.value?.profileId === p.profileId) {
          activeProfile.value = updated
        }
      }
    }
  } catch {
    // Offline / 401 / anything — leave stored tokens alone. They'll
    // be reconciled on the next successful boot.
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
  }
}

interface UserPayload {
  id: string
  email: string
  name?: string
  image?: string | null
}

interface SignInData {
  user?: UserPayload
  token?: string | null
  session?: { token?: string | null } | null
}

function extractUser(result: unknown): UserPayload | null {
  return readData(result)?.user ?? null
}

function extractSessionToken(result: unknown): string | null {
  // Better Auth's email/password response surfaces the session token
  // at `data.token`; some plugin paths put it under `data.session.token`.
  // Take whichever is present.
  const data = readData(result)
  return data?.token ?? data?.session?.token ?? null
}

function readData(result: unknown): SignInData | null {
  if (!result || typeof result !== 'object') return null
  const data = (result as { data?: unknown }).data
  return data && typeof data === 'object' ? (data as SignInData) : null
}
