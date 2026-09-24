import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../../api'
import * as engineStore from './engineStore'
import * as idb from './persistence'
import { freshIdb, queuedReview, seedQueue, stubEngine, syncState } from './testing/harness'
import type { SyncEventsRequest, SyncEventsResponse } from './types'

vi.mock('./engineLoader', () => ({ createEngine: vi.fn(() => stubEngine()) }))
vi.mock('../../api', () => ({
  api: { getSyncState: vi.fn(), postSyncEvents: vi.fn(), postSyncConfirm: vi.fn() },
}))

const M = 'nkjv-john'
const NOW = 1_790_100_000

const postSyncEvents = vi.mocked(api.postSyncEvents)

/** A merged response that took every event in `body`, as the current
 *  server does. */
function tookAll(
  body: SyncEventsRequest,
  extra: Partial<Extract<SyncEventsResponse, { accepted: number }>> = {},
): SyncEventsResponse {
  return {
    accepted: body.events.length,
    duplicates: 0,
    rebuilt: false,
    testStates: [],
    lastEventId: null,
    stateRev: 'rev-1',
    dispositions: body.events.map((e, index) => ({
      index,
      clientEventId: e.clientEventId,
      disposition: 'applied' as const,
    })),
    ...extra,
  }
}

const SUMMARY = {
  queuedCount: 2,
  serverEventsSince: 11,
  oldestQueuedTs: 1_700_000_000,
  newestServerTs: 1_700_001_010,
}

describe('engineStore.flush', () => {
  beforeEach(async () => {
    await engineStore.clearAllSessions()
    await freshIdb()
    vi.mocked(api.getSyncState).mockResolvedValue(syncState())
    postSyncEvents.mockReset()
    await engineStore.loadEngine(M, NOW)
  })

  it('forgets every event it sent once answered, whatever the dispositions say', async () => {
    // Dispositions inform; they do not decide deletion. An event the
    // server could not even name must still leave the outbox (FR-005).
    await seedQueue([queuedReview(M), queuedReview(M), queuedReview(M)])
    const unrecognised = { index: 0, clientEventId: null, disposition: 'someday' as 'applied' }
    postSyncEvents.mockImplementation(async (_m, body) =>
      tookAll(body, { dispositions: [unrecognised] }))

    await engineStore.flush(M, NOW)

    expect(await idb.countQueuedEvents(M)).toBe(0)
  })

  it('drains an outbox past the per-request cap in pages', async () => {
    await seedQueue(Array.from({ length: 501 }, () => queuedReview(M)))
    postSyncEvents.mockImplementation(async (_m, body) => tookAll(body))

    const result = await engineStore.flush(M, NOW)

    expect(postSyncEvents.mock.calls.map(([, body]) => body.events.length)).toEqual([500, 1])
    expect(result.accepted).toBe(501)
    expect(await idb.countQueuedEvents(M)).toBe(0)
  })

  it('empties the outbox when the server holds a stale batch, and asks', async () => {
    await seedQueue([queuedReview(M), queuedReview(M)])
    const before = await idb.getAllTestStates(M)
    postSyncEvents.mockImplementation(async (_m, body) =>
      tookAll(body, {
        accepted: 0,
        needsConfirm: true,
        staleSummary: SUMMARY,
        testStates: [{ test_kind: 'x' } as never],
      }))

    await engineStore.flush(M, NOW)

    expect(await idb.countQueuedEvents(M)).toBe(0)
    expect(engineStore.firstStalePrompt()).toEqual({ materialId: M, ...SUMMARY })
    // The server's state still lacks the held batch; it is not adopted.
    expect(await idb.getAllTestStates(M)).toEqual(before)
  })

  it('keeps the outbox when an older server asks without taking anything', async () => {
    // Deploy order is not guaranteed: an api from before this change
    // answers a stale batch with a bare needsConfirm and takes nothing.
    await seedQueue([queuedReview(M), queuedReview(M)])
    postSyncEvents.mockResolvedValue({ needsConfirm: true, staleSummary: SUMMARY })

    await engineStore.flush(M, NOW)
    // A second flush must not re-send the same batch in a loop.
    await engineStore.flush(M, NOW)

    expect(postSyncEvents).toHaveBeenCalledTimes(1)
    expect(await idb.countQueuedEvents(M)).toBe(2)
    expect(engineStore.firstStalePrompt()).toEqual({ materialId: M, ...SUMMARY })
  })

  it('answers a server-held question through the confirm route and clears it', async () => {
    await seedQueue([queuedReview(M)])
    postSyncEvents.mockImplementation(async (_m, body) =>
      tookAll(body, { accepted: 0, needsConfirm: true, staleSummary: SUMMARY }))
    await engineStore.flush(M, NOW)
    vi.mocked(api.postSyncConfirm).mockResolvedValue({ discarded: 1 })
    // Graded after the question was raised: must reach the server before
    // the answer rebuilds the engine from it.
    await seedQueue([queuedReview(M)])
    postSyncEvents.mockImplementation(async (_m, body) => tookAll(body))

    await engineStore.answerMergeQuestion(M, 'discard', NOW)

    expect(api.postSyncConfirm).toHaveBeenCalledWith(M, 'discard')
    expect(await idb.countQueuedEvents(M)).toBe(0)
    expect(engineStore.firstStalePrompt()).toBeNull()
  })

  it("answers an older server's question by re-sending the held outbox", async () => {
    await seedQueue([queuedReview(M), queuedReview(M)])
    postSyncEvents.mockResolvedValueOnce({ needsConfirm: true, staleSummary: SUMMARY })
    await engineStore.flush(M, NOW)

    postSyncEvents.mockImplementation(async (_m, body) => tookAll(body))
    await engineStore.answerMergeQuestion(M, 'merge', NOW)

    const calls = postSyncEvents.mock.calls
    expect(calls[calls.length - 1]?.[1].confirmMerge).toBe(true)
    expect(await idb.countQueuedEvents(M)).toBe(0)
    expect(engineStore.firstStalePrompt()).toBeNull()
  })
})
