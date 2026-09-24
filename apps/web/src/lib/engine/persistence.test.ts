import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import * as idb from './persistence'
import { queuedReview } from './testing/harness'

const PROFILE = 'p1'

/** Build the profile database exactly as a version-1 client left it,
 *  orphan store and all. */
async function seedV1(orphans: idb.QueuedEvent[], queued: idb.QueuedEvent[]): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(idb.profileDbName(PROFILE), 1)
    req.onupgradeneeded = () => {
      const d = req.result
      d.createObjectStore('snapshots', { keyPath: 'materialId' })
      d.createObjectStore('testStates', { keyPath: ['materialId', 'compositeKey'] })
        .createIndex('byMaterialId', 'materialId')
      for (const name of ['eventQueue', 'eventQueueOrphans']) {
        d.createObjectStore(name, { keyPath: 'clientEventId' })
          .createIndex('byMaterialId', 'materialId')
      }
      d.createObjectStore('renders', { keyPath: ['materialId', 'cardId'] })
        .createIndex('byMaterialId', 'materialId')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  const tx = db.transaction(['eventQueue', 'eventQueueOrphans'], 'readwrite')
  for (const e of orphans) tx.objectStore('eventQueueOrphans').put(e)
  for (const e of queued) tx.objectStore('eventQueue').put(e)
  await idb.transactionComplete(tx)
  db.close()
}

describe('persistence upgrade to v2', () => {
  beforeEach(async () => {
    await idb.setActiveProfile(null)
    globalThis.indexedDB = new IDBFactory()
  })

  it('moves set-aside events back into the outbox and drops the orphan store', async () => {
    // The orphan store held events a client set aside instead of
    // uploading. Client storage must hold only caches and an outbox
    // (constitution VI), so they go back where they will be delivered.
    const orphan = queuedReview('m1')
    const stillQueued = queuedReview('m1')
    await seedV1([orphan], [stillQueued])

    await idb.setActiveProfile(PROFILE)

    const queued = await idb.getQueuedEvents('m1')
    expect(queued.map((e) => e.clientEventId).sort()).toEqual(
      [orphan.clientEventId, stillQueued.clientEventId].sort(),
    )
    const db = await idb.openDb()
    expect(db.version).toBe(2)
    expect([...db.objectStoreNames]).not.toContain('eventQueueOrphans')
  })

  it('creates a fresh database without the orphan store', async () => {
    await idb.setActiveProfile(PROFILE)
    const db = await idb.openDb()
    expect([...db.objectStoreNames].sort()).toEqual(
      ['eventQueue', 'renders', 'snapshots', 'testStates'].sort(),
    )
  })
})
