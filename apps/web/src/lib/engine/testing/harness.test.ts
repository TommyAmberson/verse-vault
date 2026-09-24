import { beforeEach, describe, expect, it } from 'vitest'

import * as idb from '../persistence'
import { freshIdb, queuedReview, seedQueue, stubEngine } from './harness'

describe('engine test harness', () => {
  beforeEach(async () => {
    await freshIdb()
  })

  it('round-trips the outbox through an in-memory IndexedDB', async () => {
    await seedQueue([queuedReview('m1'), queuedReview('m1'), queuedReview('m2')])
    expect(await idb.countQueuedEvents('m1')).toBe(2)
    expect(await idb.countQueuedEvents('m2')).toBe(1)
  })

  it('starts each test with an empty database', async () => {
    expect(await idb.countAllQueuedEvents()).toBe(0)
  })

  it('stubs the engine calls the store relies on and rejects the rest', () => {
    const engine = stubEngine({ cardIds: [7] })
    expect(engine.has_card(7)).toBe(true)
    expect(engine.has_card(8)).toBe(false)
    expect(() => engine.next_review_card(0n)).toThrow(/not stubbed/)
  })
})
