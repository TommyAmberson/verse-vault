import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getIdbInterruption, openIdb, resetIdbInterruption } from './idbOpen'
import * as idb from './persistence'
import * as registry from './registry'

const PROFILE = 'p1'

/** Open a database the way a pre-fix tab does: no `onversionchange`
 *  handler, so it never lets go when a newer version is requested. */
function openAsOldTab(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('eventQueue', { keyPath: 'clientEventId' })
        .createIndex('byMaterialId', 'materialId')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Open `name` at `version` from a newer tab; resolves 'blocked' when an
 *  existing connection refuses to close. */
function openAsNewerTab(name: string, version: number): Promise<'opened' | 'blocked'> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version)
    req.onsuccess = () => {
      req.result.close()
      resolve('opened')
    }
    req.onblocked = () => resolve('blocked')
    req.onerror = () => reject(req.error)
  })
}

describe('opening a database another tab holds', () => {
  beforeEach(async () => {
    // Drop the handle without awaiting it: a failed case can leave an
    // open pending forever, and awaiting it would hang every later case.
    idb.resetDbHandle()
    await idb.setActiveProfile(null)
    registry.resetRegistryHandle()
    resetIdbInterruption()
    globalThis.indexedDB = new IDBFactory()
  })

  afterEach(() => resetIdbInterruption())

  it('reports an old tab blocking the upgrade, then carries on once it lets go', async () => {
    const oldTab = await openAsOldTab(idb.profileDbName(PROFILE), 1)

    const opening = idb.setActiveProfile(PROFILE)
    await vi.waitFor(() => expect(getIdbInterruption()).toBe('blocked'))

    oldTab.close()
    await opening
    expect(getIdbInterruption()).toBeNull()
    expect((await idb.openDb()).version).toBe(2)
  })

  it('lets go of the profile database when a newer tab upgrades it', async () => {
    await idb.setActiveProfile(PROFILE)

    expect(await openAsNewerTab(idb.profileDbName(PROFILE), 3)).toBe('opened')
    expect(getIdbInterruption()).toBe('superseded')
  })

  it('stays blocked until every blocked open has gone through', async () => {
    const oldA = await openAsOldTab('a', 1)
    const oldB = await openAsOldTab('b', 1)

    const openingA = openIdb('a', 2, () => {})
    const openingB = openIdb('b', 2, () => {})
    await vi.waitFor(() => expect(getIdbInterruption()).toBe('blocked'))

    oldA.close()
    await openingA
    expect(getIdbInterruption()).toBe('blocked')

    oldB.close()
    await openingB
    expect(getIdbInterruption()).toBeNull()
  })

  it('drops the blocked report when the open fails once unblocked', async () => {
    // Otherwise the modal keeps asking the user to close a tab that is
    // already gone, and hides the real failure.
    const oldTab = await openAsOldTab('scratch', 1)

    const opening = openIdb('scratch', 2, (req) => req.transaction!.abort())
    await vi.waitFor(() => expect(getIdbInterruption()).toBe('blocked'))

    oldTab.close()
    await expect(opening).rejects.toThrow()
    expect(getIdbInterruption()).toBeNull()
  })

  it('reports a removal, not an update, when another tab deletes the database', async () => {
    // A profile reset in another tab deletes the DB; no version changed.
    await idb.setActiveProfile(PROFILE)

    await idb.deleteIdb(idb.profileDbName(PROFILE))
    expect(getIdbInterruption()).toBe('removed')
  })

  it('lets go of the registry when a newer tab upgrades it', async () => {
    await registry.listProfiles()

    expect(await openAsNewerTab('verse-vault-registry', 3)).toBe('opened')
    expect(getIdbInterruption()).toBe('superseded')
  })
})
