/** Where a card sits in a verse's drill: a fill-in-the-blank, a card that
 *  asks for the whole verse (Recitation, Ftv), or anything else. */
export type DrillStage = 'blank' | 'whole' | 'other'

/** What the memorize drill needs to pick a card. */
export interface DrillCard {
  /** Index into the session's reading items (a verse, or a standalone
   *  heading, chapter-list or orphan card). A verse's build-up runs over
   *  its item's cards, and graduating an item drops them all. */
  itemIdx: number
  cardId: number
  stage: DrillStage
  /** The card's verse, for no-echo: cards that share it never come up
   *  back to back while another verse's card is left. */
  verse: string
  /** The blank's phrase position; blanks only. */
  phrase?: number
}

/** A card kind's drill stage. Ftv counts as whole-verse: it asks for the
 *  rest of the verse from its first words. */
export function drillStage(kind: string): DrillStage {
  if (kind === 'PhraseFill') return 'blank'
  if (kind === 'Recitation' || kind === 'Ftv') return 'whole'
  return 'other'
}

/** The memorize drill (docs/memorize.md). Each pick draws at random from
 *  the cards not yet answered Good, leaving out the verse just shown, and
 *  swaps a draw its verse isn't ready for with the card it is ready for,
 *  so every verse builds up blank by blank while verses mix at random.
 *  Again needs no call: the card stays among the cards left. */
export class Drill<T extends DrillCard> {
  private left: T[]
  private readonly shownBlanks = new Set<T>()
  private current: T | null = null

  constructor(
    cards: readonly T[],
    private readonly random: () => number = Math.random,
  ) {
    this.left = [...cards]
  }

  /** Cards not yet answered Good. */
  get remaining(): number {
    return this.left.length
  }

  /** The next card to show, or null once every card is answered Good. */
  next(): T | null {
    const others = this.left.filter((c) => c.verse !== this.current?.verse)
    const pool = others.length > 0 ? others : this.left
    this.current = pool.length > 0 ? this.readyCard(this.pickFrom(pool)) : null
    if (this.current?.stage === 'blank') this.shownBlanks.add(this.current)
    return this.current
  }

  /** The learner answered Good on the current card: done with it for the
   *  session. */
  good(): void {
    this.left = this.left.filter((c) => c !== this.current)
  }

  /** Drop every card of a reading item, such as one already memorized. */
  dropItem(itemIdx: number): void {
    this.left = this.left.filter((c) => c.itemIdx !== itemIdx)
  }

  /** The card the drawn card's verse is ready for. Unshown blanks come in
   *  phrase order, and whole-verse cards wait until every blank is Good;
   *  while missed blanks wait, a drawn whole-verse card stands in for one. */
  private readyCard(drawn: T): T {
    if (drawn.stage === 'other' || this.shownBlanks.has(drawn)) return drawn
    const blanks = this.left.filter((c) => c.itemIdx === drawn.itemIdx && c.stage === 'blank')
    const unshown = blanks
      .filter((c) => !this.shownBlanks.has(c))
      .sort((a, b) => (a.phrase ?? 0) - (b.phrase ?? 0))
    if (unshown.length > 0) return unshown[0]!
    if (blanks.length > 0) return this.pickFrom(blanks)
    return drawn
  }

  private pickFrom(cards: readonly T[]): T {
    return cards[Math.floor(this.random() * cards.length)]!
  }
}
