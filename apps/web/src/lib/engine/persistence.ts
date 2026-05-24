/**
 * IndexedDB layer for the browser-side fat-client. Five object stores
 * under one DB per profile, named `verse-vault-${profileId}`. The
 * "current profile" is a module-level variable set by
 * `setActiveProfile()` (called from `useAuth.signInComplete` /
 * `useAuth.signOut` / profile-switch paths). The shared registry of
 * known profiles + the last-active pointer lives in a separate
 * `verse-vault-registry` DB; see `./registry.ts`.
 *
 * The five stores in a profile DB:
 *
 *   - `snapshots` — one row per material (`{ materialId, version,
 *     materialData, fetchedAt }`). Source of the MaterialData blob the
 *     WASM engine consumes; mirrors `graph_snapshots` server-side.
 *   - `testStates` — materialised FSRS state per
 *     `(materialId, testKind, element)`. Fast warm-start on boot.
 *   - `eventQueue` — append-only outbound events awaiting sync. Each
 *     entry is deleted by `clientEventId` after the server acks it.
 *   - `eventQueueOrphans` — events whose `cardId` failed validation
 *     after a snapshot upgrade. Surfaced to the UI as a loud-failure
 *     affordance; never silently dropped.
 *   - `renders` — composed-HTML per card, MAUA-compliant cache. Entries
 *     with `fetchedAt > 30d` are treated as misses; bulk-invalidated on
 *     `snapshotVersion` bump.
 *
 * Hand-rolled to avoid a Dexie dependency for what's really five small
 * stores. Promise-wrapped IDBRequest primitives at the bottom.
 *
 * MAUA note: the `renders` store holds api.bible-derived content. The
 * client honours the same 30-day TTL the server's `ApibibleCache` does,
 * and never bulk-extracts: lazy fill from `/api/cards/:id` is the
 * default path; opt-in bulk-download (`GET /api/materials/:id/renders`)
 * fires only when the user flips the per-deck "Available offline"
 * toggle. See `NOTICE.md` and the
 * [API.Bible Acceptable Use](https://api.bible/terms-and-conditions#acceptable_use)
 * clause for the full rules.
 */

import type { SyncEventUpload, TestStateEntry } from './types'

const DB_VERSION = 1

/** TTL the client cache honours, mirroring the server's
 *  `CACHE_TTL_SECS` in `packages/api/src/lib/apibible-cache.ts`. */
export const RENDER_TTL_SECS = 30 * 24 * 60 * 60

/** Object-store names + the shared `byMaterialId` index name in one
 *  place. Inline string literals across the helper functions are
 *  typo-prone; centralising lets TypeScript catch typos and lets a
 *  grep for a store name find every site. */
const STORE = {
  Snapshots: 'snapshots',
  TestStates: 'testStates',
  EventQueue: 'eventQueue',
  EventQueueOrphans: 'eventQueueOrphans',
  Renders: 'renders',
} as const

const BY_MATERIAL_ID_INDEX = 'byMaterialId'

/** Profile-id of the currently active DB. Module-level — every helper
 *  in this file opens `verse-vault-${activeProfileId}` indirectly
 *  through `openDb()`. Set by `setActiveProfile` (called from the
 *  profile-switch flow); null before any profile is active. */
let activeProfileId: string | null = null
let dbPromise: Promise<IDBDatabase> | null = null

/** Open the active profile's DB (or return the cached handle). Throws
 *  if no profile is active; the caller is responsible for ordering. */
export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  if (activeProfileId == null) {
    return Promise.reject(
      new Error('No active profile — call setActiveProfile() before opening the DB.'),
    )
  }
  const dbName = profileDbName(activeProfileId)
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE.Snapshots)) {
        db.createObjectStore(STORE.Snapshots, { keyPath: 'materialId' })
      }
      if (!db.objectStoreNames.contains(STORE.TestStates)) {
        const s = db.createObjectStore(STORE.TestStates, {
          keyPath: ['materialId', 'compositeKey'],
        })
        s.createIndex(BY_MATERIAL_ID_INDEX, 'materialId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE.EventQueue)) {
        const s = db.createObjectStore(STORE.EventQueue, { keyPath: 'clientEventId' })
        s.createIndex(BY_MATERIAL_ID_INDEX, 'materialId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE.EventQueueOrphans)) {
        const s = db.createObjectStore(STORE.EventQueueOrphans, {
          keyPath: 'clientEventId',
        })
        s.createIndex(BY_MATERIAL_ID_INDEX, 'materialId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE.Renders)) {
        const s = db.createObjectStore(STORE.Renders, {
          keyPath: ['materialId', 'cardId'],
        })
        s.createIndex(BY_MATERIAL_ID_INDEX, 'materialId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

/** Set (or clear) the active profile. Closes any open handle for the
 *  previous profile and resets the cache so the next `openDb()` opens
 *  the new profile's DB. Pass `null` to detach; pass a profileId to
 *  switch. Eagerly opens the new DB so the upgrade handler runs and
 *  subsequent reads are cheap. */
export async function setActiveProfile(profileId: string | null): Promise<void> {
  if (profileId === activeProfileId) return
  // Close the existing handle (if any) before swapping.
  if (dbPromise) {
    try {
      const db = await dbPromise
      db.close()
    } catch {
      // Resolution failure on the existing promise is fine — we're
      // discarding it anyway.
    }
  }
  dbPromise = null
  activeProfileId = profileId
  if (profileId != null) {
    // Eagerly open so the upgrade handler runs now (rather than on
    // the first helper call after a profile switch).
    await openDb()
  }
}

/** Returns the currently active profile id (null if none). Mostly
 *  useful in tests + diagnostics. */
export function getActiveProfileId(): string | null {
  return activeProfileId
}

/** Drop the cached open-promise without changing the active profile.
 *  Used by tests that want to force a fresh handle on the next openDb
 *  call. */
export function resetDbHandle(): void {
  dbPromise = null
}

// --- Snapshot store ---

export interface SnapshotRow {
  materialId: string
  version: number
  /** MaterialData parsed to JSON object. Stored structured so callers
   *  don't re-parse on every read. */
  materialData: unknown
  fetchedAt: number
  /** Verse ids the user has graduated. Persisted here (alongside the
   *  snapshot rather than in a separate store) because they share a
   *  lifecycle: same (user, material) key, same wipe semantics on
   *  snapshot-version drift. Optional for backward-compat — rows
   *  written before the field existed read back as undefined and are
   *  treated as an empty list. */
  graduatedVerseIds?: number[]
}

export async function getSnapshot(materialId: string): Promise<SnapshotRow | undefined> {
  const db = await openDb()
  return promiseRequest<SnapshotRow | undefined>(
    db.transaction(STORE.Snapshots, 'readonly').objectStore(STORE.Snapshots).get(materialId),
  )
}

export async function putSnapshot(row: SnapshotRow): Promise<void> {
  const db = await openDb()
  await promiseRequest(
    db.transaction(STORE.Snapshots, 'readwrite').objectStore(STORE.Snapshots).put(row),
  )
}

// --- Test-states store ---

function testStateCompositeKey(entry: TestStateEntry): string {
  // JSON.stringify of the element is stable across writes — same shape,
  // same key. Combined with test_kind it's unique per engine entry.
  return `${entry.test_kind}|${JSON.stringify(entry.element)}`
}

interface TestStateRow {
  materialId: string
  compositeKey: string
  entry: TestStateEntry
}

export async function getAllTestStates(materialId: string): Promise<TestStateEntry[]> {
  const db = await openDb()
  const tx = db.transaction(STORE.TestStates, 'readonly')
  const store = tx.objectStore(STORE.TestStates)
  const idx = store.index(BY_MATERIAL_ID_INDEX)
  return promiseRequest<TestStateRow[]>(idx.getAll(materialId)).then((rows) =>
    rows.map((r) => r.entry),
  )
}

/** Replace all test states for one material in a single transaction.
 *  Used by the rebuild flow when the server returns a freshly-replayed
 *  set, and by the initial sync-state load. */
export async function replaceAllTestStates(
  materialId: string,
  entries: TestStateEntry[],
): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE.TestStates, 'readwrite')
  const store = tx.objectStore(STORE.TestStates)
  const idx = store.index(BY_MATERIAL_ID_INDEX)
  // Delete existing rows for this material first. getAllKeys is faster
  // than fetching the full rows when we only need to delete.
  const existingKeys = await promiseRequest<IDBValidKey[]>(idx.getAllKeys(materialId))
  for (const k of existingKeys) store.delete(k)
  for (const entry of entries) {
    const row: TestStateRow = {
      materialId,
      compositeKey: testStateCompositeKey(entry),
      entry,
    }
    store.put(row)
  }
  await transactionComplete(tx)
}

// --- Event-queue store ---

export type QueuedEvent = SyncEventUpload & { materialId: string }

export async function appendQueuedEvent(event: QueuedEvent): Promise<void> {
  const db = await openDb()
  await promiseRequest(
    db.transaction(STORE.EventQueue, 'readwrite').objectStore(STORE.EventQueue).put(event),
  )
}

export async function getQueuedEvents(materialId: string): Promise<QueuedEvent[]> {
  const db = await openDb()
  const tx = db.transaction(STORE.EventQueue, 'readonly')
  const idx = tx.objectStore(STORE.EventQueue).index(BY_MATERIAL_ID_INDEX)
  return promiseRequest<QueuedEvent[]>(idx.getAll(materialId))
}

/** Cheap row count without materialising the rows — IDB `count()` runs
 *  against the index directly. Hot path: refreshCounts after every grade. */
export async function countQueuedEvents(materialId: string): Promise<number> {
  const db = await openDb()
  const tx = db.transaction(STORE.EventQueue, 'readonly')
  const idx = tx.objectStore(STORE.EventQueue).index(BY_MATERIAL_ID_INDEX)
  return promiseRequest<number>(idx.count(IDBKeyRange.only(materialId)))
}

/** Total queued events across all materials for the active profile.
 *  Used by the offline banner where the workspace doesn't know (or
 *  doesn't surface) the active materialId. */
export async function countAllQueuedEvents(): Promise<number> {
  const db = await openDb()
  return promiseRequest<number>(
    db.transaction(STORE.EventQueue, 'readonly').objectStore(STORE.EventQueue).count(),
  )
}

/** Delete acked events by clientEventId. Mid-flush additions to the
 *  queue survive because we delete by explicit key, not by clearing
 *  the whole store. */
export async function deleteQueuedEvents(clientEventIds: string[]): Promise<void> {
  if (clientEventIds.length === 0) return
  const db = await openDb()
  const tx = db.transaction(STORE.EventQueue, 'readwrite')
  const store = tx.objectStore(STORE.EventQueue)
  for (const id of clientEventIds) store.delete(id)
  await transactionComplete(tx)
}

// --- Orphan-queue store ---

export async function moveToOrphans(events: QueuedEvent[]): Promise<void> {
  if (events.length === 0) return
  const db = await openDb()
  const tx = db.transaction([STORE.EventQueue, STORE.EventQueueOrphans], 'readwrite')
  const queue = tx.objectStore(STORE.EventQueue)
  const orphans = tx.objectStore(STORE.EventQueueOrphans)
  for (const e of events) {
    queue.delete(e.clientEventId)
    orphans.put(e)
  }
  await transactionComplete(tx)
}

export async function getOrphans(materialId: string): Promise<QueuedEvent[]> {
  const db = await openDb()
  const tx = db.transaction(STORE.EventQueueOrphans, 'readonly')
  const idx = tx.objectStore(STORE.EventQueueOrphans).index(BY_MATERIAL_ID_INDEX)
  return promiseRequest<QueuedEvent[]>(idx.getAll(materialId))
}

/** Cheap orphan count. Pairs with countQueuedEvents for the
 *  refreshCounts reactive surface. */
export async function countOrphans(materialId: string): Promise<number> {
  const db = await openDb()
  const tx = db.transaction(STORE.EventQueueOrphans, 'readonly')
  const idx = tx.objectStore(STORE.EventQueueOrphans).index(BY_MATERIAL_ID_INDEX)
  return promiseRequest<number>(idx.count(IDBKeyRange.only(materialId)))
}

// --- Render cache (MAUA-compliant) ---

export interface RenderRow {
  materialId: string
  cardId: number
  /** Pre-composed HTML output of `composeRender` on the server. */
  composed: unknown
  fetchedAt: number
}

export async function getRender(
  materialId: string,
  cardId: number,
  nowSecs: number,
): Promise<RenderRow | undefined> {
  const db = await openDb()
  const row = await promiseRequest<RenderRow | undefined>(
    db.transaction(STORE.Renders, 'readonly').objectStore(STORE.Renders).get([materialId, cardId]),
  )
  if (!row) return undefined
  // TTL-on-read: treat anything past 30d as a miss so callers refresh.
  if (nowSecs - row.fetchedAt > RENDER_TTL_SECS) return undefined
  return row
}

export async function putRender(row: RenderRow): Promise<void> {
  const db = await openDb()
  await promiseRequest(
    db.transaction(STORE.Renders, 'readwrite').objectStore(STORE.Renders).put(row),
  )
}

/** Replace every render for `materialId` with `rows` in one transaction.
 *  Used by the opt-in bulk-download path: existing entries (possibly
 *  partial from the lazy path) are dropped first so a stale subset
 *  can't shadow the fresh batch. */
export async function bulkPutRenders(
  materialId: string,
  rows: RenderRow[],
): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE.Renders, 'readwrite')
  const store = tx.objectStore(STORE.Renders)
  const idx = store.index(BY_MATERIAL_ID_INDEX)
  const existing = await promiseRequest<IDBValidKey[]>(idx.getAllKeys(materialId))
  for (const k of existing) store.delete(k)
  for (const row of rows) store.put(row)
  await transactionComplete(tx)
}

/** Newest fetchedAt across all renders for the material, or 0 if none.
 *  Drives the "Last refreshed N days ago" indicator + the background-
 *  refresh check on app boot. */
export async function newestRenderFetchedAt(materialId: string): Promise<number> {
  const db = await openDb()
  const tx = db.transaction(STORE.Renders, 'readonly')
  const idx = tx.objectStore(STORE.Renders).index(BY_MATERIAL_ID_INDEX)
  const rows = await promiseRequest<RenderRow[]>(idx.getAll(materialId))
  let max = 0
  for (const r of rows) if (r.fetchedAt > max) max = r.fetchedAt
  return max
}

/** Clear all renders for a material. Used on snapshotVersion bump:
 *  composed HTML is stale even if within TTL once the deck structure
 *  changes underneath. */
export async function clearRenders(materialId: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE.Renders, 'readwrite')
  const store = tx.objectStore(STORE.Renders)
  const idx = store.index(BY_MATERIAL_ID_INDEX)
  const keys = await promiseRequest<IDBValidKey[]>(idx.getAllKeys(materialId))
  for (const k of keys) store.delete(k)
  await transactionComplete(tx)
}

// --- IDB → Promise primitives ---

export function promiseRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** Canonical name of the per-profile DB for `profileId`. Single source
 *  of truth for the template; both `openDb()` here and `registry.ts`'s
 *  existence check route through it. */
export function profileDbName(profileId: string): string {
  return `verse-vault-${profileId}`
}

/** Drop a named IDB database. Resolves on success; resolves (not
 *  rejects) on `onblocked` — the caller has already done what it can
 *  to release its own handle, so a holding connection from another
 *  tab is a "best-effort, try again later" situation rather than a
 *  hard failure. */
export function deleteIdb(dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
}
