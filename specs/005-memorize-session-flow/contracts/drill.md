# Contract: the memorize drill's pick rule

Internal to `apps/web`; recorded because the spec's drill criteria (SC-003, SC-006) are tested
against it. The owner is `apps/web/src/lib/drillOrder.ts`; the view only reports Good or Again and
asks for the next card.

**Input**: the drill cards of the session's remaining items (see
[data-model.md](../data-model.md#drill-card)) and a random source, injectable for seeded tests.

**Each pick**:

1. Candidates are the cards not yet answered Good, minus the cards whose verse matches the card just
   shown, unless that leaves none.
2. Draw one candidate uniformly at random.
3. Swap it by the table in [research.md D2](../research.md#d2-how-the-picker-chooses).

**Answers**: Good removes the shown card. Again keeps it; a blank stays marked shown.

**"Already memorized"** in the read phase drops the item's cards before the drill starts, so the
drill only holds cards of items still in the session.

**Guarantees** (tested over many seeds):

* A verse's blanks are first shown in ascending phrase position.
* A verse's whole-verse cards are shown only after all its blanks are answered Good.
* No two consecutive picks share a verse while a card of another verse, or an extra, remains.
* Every card is eventually answered Good if the learner answers Good, so the drill ends.
