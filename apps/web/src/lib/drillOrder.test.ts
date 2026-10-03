import { describe, expect, it } from 'vitest'
import { drillStage, orderDrill, requeueMissed, type DrillCard, type DrillStage } from './drillOrder'

const card = (itemIdx: number, cardId: number, stage: DrillStage): DrillCard => ({
  itemIdx,
  cardId,
  stage,
})

/** Every item's whole-verse cards come after all of that item's blanks. */
function blanksFirst(queue: DrillCard[]): boolean {
  return queue.every(
    (c, i) =>
      c.stage !== 'whole' ||
      queue.slice(i + 1).every((later) => later.itemIdx !== c.itemIdx || later.stage !== 'blank'),
  )
}

/** A deterministic stand-in for Math.random, seeded per run. */
function seeded(seed: number): () => number {
  let s = seed
  return () => (s = (s * 9301 + 49297) % 233280) / 233280
}

// Verse 0: two blanks, a recitation and an FTV, plus a citation-style card.
// Verse 1: one blank and a recitation. Item 2: a standalone heading card.
// Item 3: a verse with blanks only.
const pool = [
  card(0, 1, 'blank'),
  card(0, 2, 'blank'),
  card(0, 3, 'whole'),
  card(0, 4, 'whole'),
  card(0, 5, 'other'),
  card(1, 6, 'blank'),
  card(1, 7, 'whole'),
  card(2, 8, 'other'),
  card(3, 9, 'blank'),
]

describe('orderDrill', () => {
  it('puts each verse whole-verse cards after its blanks, whatever the shuffle', () => {
    for (let seed = 0; seed < 200; seed++) {
      const queue = orderDrill(pool, seeded(seed))
      expect(queue).toHaveLength(pool.length)
      expect(new Set(queue.map((c) => c.cardId))).toEqual(new Set(pool.map((c) => c.cardId)))
      expect(blanksFirst(queue)).toBe(true)
    }
  })

  it('leaves the other cards where the shuffle put them', () => {
    for (let seed = 0; seed < 50; seed++) {
      const queue = orderDrill(pool, seeded(seed))
      // The same seed with every card 'other' is the plain shuffle.
      const plain = orderDrill(
        pool.map((c) => ({ ...c, stage: 'other' as const })),
        seeded(seed),
      )
      for (const c of pool.filter((c) => c.stage === 'other')) {
        const at = (q: DrillCard[]) => q.findIndex((x) => x.cardId === c.cardId)
        expect(at(queue)).toBe(at(plain))
      }
    }
  })

  it('still interleaves verses rather than grouping them', () => {
    const orders = new Set<string>()
    for (let seed = 0; seed < 200; seed++) {
      orders.add(orderDrill(pool, seeded(seed)).map((c) => c.cardId).join(','))
    }
    expect(orders.size).toBeGreaterThan(10)
  })
})

describe('requeueMissed', () => {
  it('sends a missed card to the back', () => {
    const queue = [card(0, 1, 'blank'), card(1, 6, 'blank'), card(1, 7, 'whole')]
    expect(requeueMissed(queue).map((c) => c.cardId)).toEqual([6, 7, 1])
  })

  it('keeps a verse whole-verse cards behind its missed blank', () => {
    const queue = [card(0, 1, 'blank'), card(0, 3, 'whole'), card(1, 6, 'blank'), card(0, 4, 'whole')]
    expect(requeueMissed(queue).map((c) => c.cardId)).toEqual([6, 1, 3, 4])
  })

  it('sends a missed whole-verse card to the back on its own', () => {
    const queue = [card(0, 3, 'whole'), card(1, 6, 'blank')]
    expect(requeueMissed(queue).map((c) => c.cardId)).toEqual([6, 3])
  })

  it('moves only the missed blank when its whole-verse cards are done', () => {
    const queue = [card(0, 1, 'blank'), card(1, 6, 'blank'), card(1, 7, 'whole')]
    expect(requeueMissed(queue).map((c) => c.cardId)).toEqual([6, 7, 1])
  })

  it('leaves an empty queue alone', () => {
    expect(requeueMissed([])).toEqual([])
  })
})

describe('drillStage', () => {
  it('sorts card kinds into blanks, whole-verse cards and the rest', () => {
    expect(drillStage('PhraseFill')).toBe('blank')
    expect(drillStage('Recitation')).toBe('whole')
    expect(drillStage('Ftv')).toBe('whole')
    expect(drillStage('Citation')).toBe('other')
    expect(drillStage('HeadingPassage')).toBe('other')
  })
})
