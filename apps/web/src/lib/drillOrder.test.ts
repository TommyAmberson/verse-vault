import { describe, expect, it } from 'vitest'
import { Drill, drillStage, type DrillCard, type DrillStage } from './drillOrder'

const card = (
  itemIdx: number,
  cardId: number,
  stage: DrillStage,
  phrase?: number,
  verse = `v${itemIdx}`,
): DrillCard => ({ itemIdx, cardId, stage, verse, phrase })

/** A deterministic stand-in for Math.random, seeded per run. */
function seeded(seed: number): () => number {
  let s = seed
  return () => (s = (s * 9301 + 49297) % 233280) / 233280
}

/** A random source that plays back fixed values. */
function scripted(values: number[]): () => number {
  let i = 0
  return () => values[i++ % values.length]!
}

// Verse 0: three blanks, a recitation, an FTV and a location card.
// Verse 1: one blank and a recitation. Item 2: a standalone heading card.
// Item 3: a verse with blanks only. Item 4: a verse with no blanks.
// Items 5 and 6: two orphans of one memorized verse.
const pool = [
  card(0, 1, 'blank', 0),
  card(0, 2, 'blank', 1),
  card(0, 3, 'blank', 2),
  card(0, 4, 'whole'),
  card(0, 5, 'whole'),
  card(0, 6, 'other'),
  card(1, 7, 'blank', 0),
  card(1, 8, 'whole'),
  card(2, 9, 'other'),
  card(3, 10, 'blank', 0),
  card(3, 11, 'blank', 1),
  card(4, 12, 'whole'),
  card(4, 13, 'other'),
  card(5, 14, 'whole', undefined, 'm9'),
  card(6, 15, 'other', undefined, 'm9'),
]

interface Step {
  shown: DrillCard
  /** Cards not yet answered Good just before this pick. */
  left: DrillCard[]
  good: boolean
}

/** Run a drill to its end, answering Again about a third of the time. */
function runDrill(cards: DrillCard[], seed: number): Step[] {
  const drill = new Drill(cards, seeded(seed))
  const answers = seeded(seed + 1)
  const left = new Set(cards)
  const steps: Step[] = []
  for (let shown = drill.next(); shown !== null; shown = drill.next()) {
    if (steps.length > 10_000) throw new Error('drill did not end')
    const good = answers() > 0.35
    steps.push({ shown, left: [...left], good })
    if (good) {
      drill.good()
      left.delete(shown)
    }
  }
  expect(left.size).toBe(0)
  return steps
}

describe('Drill', () => {
  const seeds = Array.from({ length: 1000 }, (_, i) => i)

  it('shows each verse blanks first in phrase order', () => {
    for (const seed of seeds) {
      const firstShown = new Map<number, number[]>()
      for (const { shown } of runDrill(pool, seed)) {
        if (shown.stage !== 'blank') continue
        const order = firstShown.get(shown.itemIdx) ?? []
        if (!order.includes(shown.phrase!)) order.push(shown.phrase!)
        firstShown.set(shown.itemIdx, order)
      }
      for (const order of firstShown.values()) {
        expect(order).toEqual([...order].sort((a, b) => a - b))
      }
    }
  })

  it('offers whole-verse cards only once every blank of the verse is Good', () => {
    for (const seed of seeds) {
      for (const { shown, left } of runDrill(pool, seed)) {
        if (shown.stage !== 'whole') continue
        expect(left.some((c) => c.itemIdx === shown.itemIdx && c.stage === 'blank')).toBe(false)
      }
    }
  })

  it('never shows one verse twice in a row while another card is left', () => {
    for (const seed of seeds) {
      const steps = runDrill(pool, seed)
      steps.slice(1).forEach(({ shown, left }, i) => {
        if (shown.verse !== steps[i]!.shown.verse) return
        expect(left.every((c) => c.verse === shown.verse)).toBe(true)
      })
    }
  })

  it('mixes verses rather than drilling them one at a time', () => {
    const orders = new Set<string>()
    for (const seed of seeds.slice(0, 200)) {
      orders.add(runDrill(pool, seed).map((s) => s.shown.cardId).join(','))
    }
    expect(orders.size).toBeGreaterThan(100)
  })

  it('lets the next blank come up after a missed one', () => {
    // One verse, so no-echo stays out of the way: draw blank 0 and miss
    // it, then draw anything else and get blank 1.
    const drill = new Drill(
      [card(0, 1, 'blank', 0), card(0, 2, 'blank', 1), card(0, 3, 'whole')],
      scripted([0, 0.9]),
    )
    expect(drill.next()?.cardId).toBe(1)
    expect(drill.next()?.cardId).toBe(2)
  })

  it('stands a missed blank in for a whole-verse card, at random among several', () => {
    const shownAfterMisses = (pick: number) => {
      const cards = [card(0, 1, 'blank', 0), card(0, 2, 'blank', 1), card(0, 3, 'whole')]
      // Draws: blank 0, then the recitation (blank 1 stands in), then the
      // recitation again with both blanks missed, then `pick` among them.
      const drill = new Drill(cards, scripted([0, 0.9, 0.9, pick]))
      drill.next()
      drill.next()
      return drill.next()?.cardId
    }
    expect(shownAfterMisses(0.1)).toBe(1)
    expect(shownAfterMisses(0.9)).toBe(2)
  })

  it('offers a verse with no blanks its whole-verse card at once', () => {
    const drill = new Drill([card(4, 12, 'whole')], seeded(1))
    expect(drill.next()?.cardId).toBe(12)
  })

  it('drops a reading item cards', () => {
    const drill = new Drill(pool, seeded(1))
    drill.dropItem(0)
    expect(drill.remaining).toBe(pool.length - 6)
  })

  it('ends empty', () => {
    expect(new Drill([], seeded(1)).next()).toBeNull()
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
