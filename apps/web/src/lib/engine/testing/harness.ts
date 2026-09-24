/**
 * Test support for the engine store and persistence layer. Lets a test
 * drive `engineStore` against an in-memory IndexedDB and a stubbed
 * `WasmEngine`, so the flush path is testable without a wasm build.
 *
 * Tests still declare their own `vi.mock` calls, because vitest hoists
 * those per file. The usual pair is:
 *
 *   vi.mock('../engineLoader', () => ({ createEngine: vi.fn(() => stubEngine()) }))
 *   vi.mock('../../../api', () => ({ api: { getSyncState: vi.fn(), postSyncEvents: vi.fn() } }))
 */

import { IDBFactory } from 'fake-indexeddb'

import type { WasmEngine } from '../engineLoader'
import * as idb from '../persistence'
import type { SyncStateResponse } from '../types'

/** Engine methods the store calls on the paths under test. Everything
 *  else throws, so a test that wanders onto an unstubbed path fails
 *  loudly instead of passing on `undefined`. */
export interface StubEngineOpts {
  /** Card ids the engine emits. Defaults to every id. */
  cardIds?: Iterable<number>
}

export function stubEngine(opts: StubEngineOpts = {}): WasmEngine {
  const known = opts.cardIds ? new Set(opts.cardIds) : undefined
  const has = (id: number) => known === undefined || known.has(id)
  const stub = {
    has_card: (id: number) => has(id),
    graduate_card: (id: number) => has(id),
    graduate_verse: () => 0,
    replay_event: () => '[]',
    free: () => {},
  }
  return new Proxy(stub, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target]
      if (prop === 'then') return undefined
      throw new Error(`stubEngine: ${String(prop)} is not stubbed`)
    },
  }) as unknown as WasmEngine
}

/** Swap in a fresh, empty IndexedDB and activate `profileId` on it.
 *  Call from `beforeEach` so every test starts with no stores. */
export async function freshIdb(profileId = 'test-profile'): Promise<void> {
  await idb.setActiveProfile(null)
  globalThis.indexedDB = new IDBFactory()
  await idb.setActiveProfile(profileId)
}

/** A minimal `GET /state` response for the cold engine-load path. */
export function syncState(overrides: Partial<SyncStateResponse> = {}): SyncStateResponse {
  return {
    snapshot: { version: 1, materialData: {} },
    testStates: [],
    lastEventId: null,
    graduatedVerseIds: [],
    graduatedCardIds: [],
    stateRev: 'rev-0',
    ...overrides,
  }
}

let nextEventId = 0

/** A queued review event for `materialId`, with a unique id. */
export function queuedReview(
  materialId: string,
  overrides: Partial<idb.QueuedEvent> = {},
): idb.QueuedEvent {
  nextEventId += 1
  return {
    materialId,
    kind: 'review',
    clientEventId: `evt-${nextEventId}`,
    timestampSecs: 1_790_000_000 + nextEventId,
    snapshotVersion: 1,
    cardId: 65_536,
    grade: 3,
    ...overrides,
  } as idb.QueuedEvent
}

/** Append `events` to the outbox. */
export async function seedQueue(events: idb.QueuedEvent[]): Promise<void> {
  for (const e of events) await idb.appendQueuedEvent(e)
}
