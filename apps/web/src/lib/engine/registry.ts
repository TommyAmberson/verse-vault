/**
 * Profile registry: the shared `verse-vault-registry` IndexedDB that
 * tracks which profiles exist on this device + which one was most
 * recently active. The router reads this on every boot to decide
 * whether to auto-enter a profile or fall through to the sign-in form.
 *
 * Profile *data* (snapshots, testStates, eventQueue, …) lives in a
 * separate per-profile DB named `verse-vault-${profileId}` — see
 * `persistence.ts`. The registry is the only thing readable before
 * we know which profile-DB to open.
 */

import { profileDbName, promiseRequest, transactionComplete } from './persistence'

const DB_NAME = 'verse-vault-registry'
const DB_VERSION = 2

const STORE = {
  Profiles: 'profiles',
  Meta: 'meta',
} as const

/** Singleton key the `meta` store uses — there is only ever one row. */
const META_KEY = 'singleton'

/** How the user last authenticated this profile. Drives the picker's
 *  re-auth: a `'google'` profile whose stored token is dead re-auths
 *  straight through the OAuth flow rather than the email/password form.
 *  `undefined` on rows written before this was tracked — treated as
 *  unknown, falling back to the email form. */
export type AuthProvider = 'google' | 'email'

export interface ProfileRow {
  /** Server-side `userId`; doubles as the per-profile DB suffix. */
  profileId: string
  email: string
  /** Falls back to email when the server has no name. */
  displayName: string
  image: string | null
  createdAt: number
  lastUsedAt: number
  /** Better Auth session token for this profile's multi-session cookie,
   *  or null when the profile is signed-out on this device. The picker
   *  uses this to drive the signed-in/out chip and to call
   *  `multiSession.setActive` / `multiSession.revoke` by token. */
  sessionToken: string | null
  /** Sign-in method last used for this profile; `undefined` on legacy
   *  rows written before it was tracked. */
  provider?: AuthProvider
}

interface MetaRow {
  key: typeof META_KEY
  lastActiveProfileId: string | null
}

let dbPromise: Promise<IDBDatabase> | null = null

export function openRegistry(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (ev) => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE.Profiles)) {
        db.createObjectStore(STORE.Profiles, { keyPath: 'profileId' })
      }
      if (!db.objectStoreNames.contains(STORE.Meta)) {
        db.createObjectStore(STORE.Meta, { keyPath: 'key' })
      }
      // v1 → v2: backfill `sessionToken: null` on every existing row so
      // reads don't need to coerce `undefined`. New devices skip this
      // (oldVersion === 0); v1-era users get one cursor-pass on first
      // launch post-PR-C. Runs inside the upgrade transaction.
      if (ev.oldVersion < 2) {
        const tx = req.transaction
        if (tx) {
          const store = tx.objectStore(STORE.Profiles)
          store.openCursor().onsuccess = (cursorEv) => {
            const cursor = (cursorEv.target as IDBRequest<IDBCursorWithValue>).result
            if (!cursor) return
            const row = cursor.value as Partial<ProfileRow>
            if (row.sessionToken === undefined) {
              cursor.update({ ...row, sessionToken: null })
            }
            cursor.continue()
          }
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

export async function listProfiles(): Promise<ProfileRow[]> {
  const db = await openRegistry()
  return promiseRequest<ProfileRow[]>(
    db.transaction(STORE.Profiles, 'readonly').objectStore(STORE.Profiles).getAll(),
  )
}

export async function getProfile(profileId: string): Promise<ProfileRow | undefined> {
  const db = await openRegistry()
  return promiseRequest<ProfileRow | undefined>(
    db.transaction(STORE.Profiles, 'readonly').objectStore(STORE.Profiles).get(profileId),
  )
}

export async function upsertProfile(row: ProfileRow): Promise<void> {
  const db = await openRegistry()
  await promiseRequest(
    db.transaction(STORE.Profiles, 'readwrite').objectStore(STORE.Profiles).put(row),
  )
}

export async function removeProfile(profileId: string): Promise<void> {
  const db = await openRegistry()
  await promiseRequest(
    db.transaction(STORE.Profiles, 'readwrite').objectStore(STORE.Profiles).delete(profileId),
  )
}

export async function getLastActiveProfileId(): Promise<string | null> {
  const db = await openRegistry()
  const row = await promiseRequest<MetaRow | undefined>(
    db.transaction(STORE.Meta, 'readonly').objectStore(STORE.Meta).get(META_KEY),
  )
  return row?.lastActiveProfileId ?? null
}

export async function setLastActiveProfileId(profileId: string | null): Promise<void> {
  const db = await openRegistry()
  const row: MetaRow = { key: META_KEY, lastActiveProfileId: profileId }
  await promiseRequest(
    db.transaction(STORE.Meta, 'readwrite').objectStore(STORE.Meta).put(row),
  )
}

/** Cheap existence check for the per-profile DB. The launch path uses
 *  this to detect the "registry points at a missing DB" edge case
 *  (browser cleared site data, dev manually deleted the DB, etc.) and
 *  fall back to the picker. */
export async function profileDbExists(profileId: string): Promise<boolean> {
  // `indexedDB.databases()` is missing on older Safari; treat its
  // absence as "assume the DB exists" — opening it will recreate
  // harmlessly if it doesn't.
  if (typeof indexedDB.databases !== 'function') return true
  const list = await indexedDB.databases()
  return list.some((d) => d.name === profileDbName(profileId))
}

/** Test/dev helper: drop the cached open-promise so the next call to
 *  openRegistry re-opens. The actual data on disk is untouched. */
export function resetRegistryHandle(): void {
  dbPromise = null
}

/** Updates the profile's `lastUsedAt` timestamp and returns the
 *  updated row (or null if the profile doesn't exist). Cheap shorthand
 *  for the common pattern of "I just entered this profile, give me
 *  back the touched row to render." */
export async function touchProfile(
  profileId: string,
  nowSecs: number,
): Promise<ProfileRow | null> {
  const existing = await getProfile(profileId)
  if (!existing) return null
  const updated: ProfileRow = { ...existing, lastUsedAt: nowSecs }
  await upsertProfile(updated)
  return updated
}

/** Set or clear the Better Auth session token for a profile. Returns
 *  the updated row, or null when the profile doesn't exist. Callers in
 *  useAuth use this after sign-in (set), sign-out (null), and the boot
 *  reconciliation pass (null on tokens the server no longer knows). */
export async function updateProfileSessionToken(
  profileId: string,
  sessionToken: string | null,
): Promise<ProfileRow | null> {
  const existing = await getProfile(profileId)
  if (!existing) return null
  const updated: ProfileRow = { ...existing, sessionToken }
  await upsertProfile(updated)
  return updated
}

/** Compare-and-clear: null the profile's session token only if it still
 *  holds `expectedToken`. Returns the updated row when the clear applied,
 *  or null when the row is gone or its token has since changed. The boot
 *  reconciliation pass judges a token stale from a snapshot, then writes
 *  the null asynchronously; a concurrent session-watcher fire can write a
 *  freshly-issued token in that gap, and an unconditional null would wipe
 *  it (see #127). Guarding on the exact token judged stale skips that
 *  write. The get and the put share one transaction — issuing the put
 *  synchronously from `onsuccess` — so the check and clear can't
 *  interleave (an `await` between them would let the transaction
 *  auto-commit before the put). */
export async function clearSessionTokenIfMatches(
  profileId: string,
  expectedToken: string,
): Promise<ProfileRow | null> {
  const db = await openRegistry()
  const tx = db.transaction(STORE.Profiles, 'readwrite')
  const store = tx.objectStore(STORE.Profiles)
  let updated: ProfileRow | null = null
  const getReq = store.get(profileId)
  getReq.onsuccess = () => {
    const existing = getReq.result as ProfileRow | undefined
    if (existing && existing.sessionToken === expectedToken) {
      updated = { ...existing, sessionToken: null }
      store.put(updated)
    }
  }
  await transactionComplete(tx)
  return updated
}
