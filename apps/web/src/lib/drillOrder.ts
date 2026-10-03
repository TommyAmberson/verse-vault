/** Where a card sits in a verse's drill: a fill-in-the-blank, a card that
 *  asks for the whole verse (Recitation, Ftv), or anything else. */
export type DrillStage = 'blank' | 'whole' | 'other'

/** What the memorize drill needs to order a card. */
export interface DrillCard {
  /** Index into the session's reading items (a verse, or a standalone
   *  heading, chapter-list or orphan card), so graduating an item can
   *  drop every drill entry sourced from it in one filter. */
  itemIdx: number
  cardId: number
  stage: DrillStage
}

/** A card kind's drill stage. Ftv counts as whole-verse: it asks for the
 *  rest of the verse from its first words. */
export function drillStage(kind: string): DrillStage {
  if (kind === 'PhraseFill') return 'blank'
  if (kind === 'Recitation' || kind === 'Ftv') return 'whole'
  return 'other'
}

/** Fisher–Yates shuffle, non-mutating. */
function shuffle<T>(arr: T[], random: () => number): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i]!, out[j]!] = [out[j]!, out[i]!]
  }
  return out
}

/** Shuffle the drill so each verse's blanks come before the cards that
 *  ask for the whole verse. Within each verse, the blanks take the
 *  earliest of the places its blank and whole-verse cards landed in, and
 *  the whole-verse cards the rest, so verses still interleave at random
 *  and other cards stay where the shuffle put them. */
export function orderDrill<T extends DrillCard>(pool: T[], random: () => number = Math.random): T[] {
  const out = shuffle(pool, random)
  const slotsByItem = new Map<number, number[]>()
  out.forEach((card, i) => {
    if (card.stage === 'other') return
    const slots = slotsByItem.get(card.itemIdx) ?? []
    slots.push(i)
    slotsByItem.set(card.itemIdx, slots)
  })
  for (const slots of slotsByItem.values()) {
    const cards = slots.map((i) => out[i]!)
    const ordered = [
      ...cards.filter((c) => c.stage === 'blank'),
      ...cards.filter((c) => c.stage === 'whole'),
    ]
    slots.forEach((slot, k) => {
      out[slot] = ordered[k]!
    })
  }
  return out
}

/** Send the card at the front of the queue to the back after a miss. A
 *  missed blank also takes its verse's still-queued whole-verse cards to
 *  the back behind it, so they stay after the verse's blanks. */
export function requeueMissed<T extends DrillCard>(queue: T[]): T[] {
  const [missed, ...rest] = queue
  if (missed === undefined) return queue
  if (missed.stage !== 'blank') return [...rest, missed]
  const trailing = (c: T) => c.itemIdx === missed.itemIdx && c.stage === 'whole'
  return [...rest.filter((c) => !trailing(c)), missed, ...rest.filter(trailing)]
}
