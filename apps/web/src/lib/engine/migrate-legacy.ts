/**
 * One-shot migration: copy the legacy un-namespaced `verse-vault`
 * IndexedDB into a profile-namespaced `verse-vault-${profileId}` DB,
 * then delete the legacy. Runs once, on the first sign-in after the
 * profiles refactor lands.
 *
 * Pre-existing single-DB users (anyone who used verse-vault before
 * this PR) would otherwise lose their cached snapshots, FSRS state,
 * and queued events on first relaunch. This helper preserves that
 * data by adopting it into whatever profile signs in first.
 *
 * If the legacy DB doesn't exist, the helper is a no-op. If the copy
 * fails partway, the legacy DB is left intact (the caller logs the
 * warning and the engine refetches from the server on next material
 * load).
 */

import { promiseRequest, transactionComplete } from './persistence'

const LEGACY_DB_NAME = 'verse-vault'
const LEGACY_DB_VERSION = 1

const STORES = [
  'snapshots',
  'testStates',
  'eventQueue',
  'eventQueueOrphans',
  'renders',
] as const

export async function migrateLegacyDb(
  targetProfileId: string,
): Promise<{ migrated: boolean }> {
  const legacyExists = await checkLegacyExists()
  if (!legacyExists) return { migrated: false }

  const legacyDb = await openLegacyReadOnly()
  const targetDb = await openTargetReadWrite(targetProfileId)
  try {
    for (const storeName of STORES) {
      await copyStore(legacyDb, targetDb, storeName)
    }
  } finally {
    legacyDb.close()
    targetDb.close()
  }

  await deleteLegacy()
  return { migrated: true }
}

async function checkLegacyExists(): Promise<boolean> {
  if (typeof indexedDB.databases !== 'function') {
    // Older Safari can't enumerate; attempt the open and treat
    // upgrade-from-nothing as "no legacy data."
    return false
  }
  const list = await indexedDB.databases()
  return list.some((d) => d.name === LEGACY_DB_NAME)
}

function openLegacyReadOnly(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    // No upgrade handler — if the legacy DB doesn't have a store we
    // expect, copyStore() handles the missing-store case gracefully.
  })
}

function openTargetReadWrite(profileId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`verse-vault-${profileId}`)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    // Target DB's upgrade handler is in persistence.ts. We rely on
    // setActiveProfile having already opened the target once before
    // this runs — so it already has all stores created.
  })
}

function deleteLegacy(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(LEGACY_DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => {
      // Another tab holding a handle to the legacy DB — drop the
      // wait and continue. The user's data has already been copied
      // to the target by this point (delete is the final step), so
      // they keep their cards. The legacy DB just sticks around
      // taking up storage until the holding tab closes; the next
      // first-ever sign-in (no profiles in registry) will see it
      // and retry the cleanup. Subsequent sign-ins for the SAME
      // user skip migration entirely (gate is per-device, not
      // per-user) so we don't accidentally re-copy stale data.
      resolve()
    }
  })
}

async function copyStore(
  source: IDBDatabase,
  target: IDBDatabase,
  storeName: (typeof STORES)[number],
): Promise<void> {
  if (!source.objectStoreNames.contains(storeName)) return
  const sourceTx = source.transaction(storeName, 'readonly')
  const rows = await promiseRequest<unknown[]>(
    sourceTx.objectStore(storeName).getAll(),
  )
  if (rows.length === 0) return
  const targetTx = target.transaction(storeName, 'readwrite')
  const targetStore = targetTx.objectStore(storeName)
  for (const row of rows) targetStore.put(row)
  await transactionComplete(targetTx)
}
