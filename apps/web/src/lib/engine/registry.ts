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
const DB_VERSION = 1

const STORE = {
  Profiles: 'profiles',
  Meta: 'meta',
} as const

/** Singleton key the `meta` store uses — there is only ever one row. */
const META_KEY = 'singleton'

export interface ProfileRow {
  /** Server-side `userId`; doubles as the per-profile DB suffix. */
  profileId: string
  email: string
  /** Falls back to email when the server has no name. */
  displayName: string
  image: string | null
  createdAt: number
  lastUsedAt: number
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
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE.Profiles)) {
        db.createObjectStore(STORE.Profiles, { keyPath: 'profileId' })
      }
      if (!db.objectStoreNames.contains(STORE.Meta)) {
        db.createObjectStore(STORE.Meta, { keyPath: 'key' })
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
