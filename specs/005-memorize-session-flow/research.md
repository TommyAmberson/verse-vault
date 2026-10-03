# Research: Memorize Session Flow

Decisions behind [plan.md](./plan.md). Each records what was chosen, why, and what was set aside.

## D1. The drill picker stays in the web client

**Decision**: The drill's pick rule (FR-004 to FR-006, FR-013) replaces the shuffle-and-requeue rule
in `apps/web/src/lib/drillOrder.ts`, the file that holds it since web 0.10.1. `MemorizeView.vue`
asks it for each next card instead of reading the front of a pre-ordered queue.

**Rationale**: The drill is unrecorded practice. It touches no memory state, schedules nothing, and
two clients drilling in different orders cannot disagree about a learner's state, so Principle II
(algorithm semantics live in core) is not engaged. Keeping it beside the view keeps it a pure,
seedable function that vitest can drive thousands of times without a wasm build.

**Alternatives considered**: Moving the picker into core and exposing it through wasm. Rejected: it
would put per-pick UI state across the wasm boundary for no consistency gain, and add contract bumps
for a presentation rule.

## D2. How the picker chooses

**Decision**: Each pick draws uniformly from the cards not yet answered Good, leaving out the cards
of the verse just shown while any other card remains (FR-013). The draw then swaps a card the verse
is not ready for, as FR-005 states:

| Drawn card                                                    | Shown instead                             |
| ------------------------------------------------------------- | ----------------------------------------- |
| a blank already shown and missed                              | itself                                    |
| a blank not yet shown                                         | the verse's lowest-position unshown blank |
| a whole-verse card, the verse still has unshown blanks        | the verse's lowest-position unshown blank |
| a whole-verse card, every blank shown, some missed blanks     | one of those missed blanks, at random     |
| a whole-verse card, every blank Good                          | itself                                    |
| anything else (location card, heading, chapter list, orphans) | itself                                    |

Good removes the shown card. Again leaves it among the cards left; a missed blank stays "shown", so
it is drawn only as itself or as a stand-in for a whole-verse card.

**Rationale**: This is the user's "draw any card, then replace it with the proper one" formulation
from the clarify session. It gives each verse a pick rate equal to the cards it has left without
computing weights, and every rule in the spec is a row of the table.

**Alternatives considered**: Explicit weights per verse (same distribution, more state). Keeping the
pre-ordered queue and patching it on Again (the 0.10.1 shape; it cannot express "missed blank does
not block the next blank" without re-sorting).

## D3. What "the same verse" means for no-echo

**Decision**: A drill card's verse is its material plus the verse id its render carries. Every card
of a verse item shares it; an orphan shares it with any other orphan from the same memorized verse;
a heading or chapter-list card has its own pseudo verse id and so never echoes a real verse.

**Rationale**: The clarify report left this as low impact and said the plan would default to keeping
two orphans of one verse apart. The verse id is already in the render the view fetches for every
drill card, so no new data crosses the boundary.

**Alternatives considered**: Keying on the session item, which lets two orphans of one verse come up
back to back.

## D4. Phrase order comes from the render

**Decision**: A blank's phrase position is read from its card render (`PhraseFill.position`), which
the view already fetches to classify each card's drill stage.

**Rationale**: Card ids happen to sort by position, but the id layout is the engine's business; the
render states the position outright.

## D5. Extras caps change in place in `memorize_session_v2`

**Decision**: In `crates/wasm/src/lib.rs`, `memorize_session_v2` keeps one budget of `limit` for
heading and chapter-list cards together, filled with the session's own cards (attached to a session
verse by FR-008) before catch-ups, and one budget of `limit` for orphans (first-words,
which-heading, which-club cards together) in place of today's per-kind caps. Own cards the budget
leaves out stay New; their verses are memorized by the next session, so they come back as catch-ups
on their own.

**Rationale**: Per-year caps (clarification 1) need no code: each enrolled year builds its session
from its own engine and its own `lessonBatchSize`, in both the web client and `packages/api`. The
change is a re-budgeting of loops that already exist, and the 0.12.1 orphan fix changed the same
function the same way.

**Alternatives considered**: Moving the whole session builder into core first, which Principle II
would prefer (see Complexity Tracking in the plan). Rejected for this feature: it is a refactor of
about 350 lines with no behaviour change of its own, and it would double the diff of a cap change.
Recorded as a follow-up.

## D6. Retire the core progressive reveal

**Decision**: Remove `Session::new_verse_progression` from `crates/core/src/session.rs`, the
"Progressive reveal" section of `docs/session.md`, and the doc comments in
`crates/core/src/ schedule.rs`, `crates/core/src/card.rs` and `crates/wasm/src/lib.rs` that point
callers at it.

**Rationale**: FR-010 retires a documented progression that differs from the drill. The function has
no production caller (Principle VII), only its own test.

**Alternatives considered**: Keeping the function with a note that no client uses it. Rejected by
Principle VII.

**Not decided here**: `CardKind::Reading` exists only for that progression, and the rest of the core
`Session` type also has no production caller. Both are wire- or API-visible and outside this spec;
they are raised with the user rather than folded in.

## D7. One doc owns memorize

**Decision**: `docs/memorize.md`, which owns the queue, gains the session: its items and caps, the
three phases, and the drill's pick rule. `docs/session.md` drops its progressive-reveal and
memorize-drill sections and points at `docs/memorize.md`. `docs/wasm-api.md` states the new caps.

**Rationale**: The spec splits memorize into "which verses" and "what the learner does with them";
one doc for both keeps a reader from hopping between files, and avoids a new doc. FR-011 asks for
one owner, not a new file.

**Alternatives considered**: A new `docs/memorize-session.md`.

## D8. Validation without the simulator

**Decision**: Tests, not a sim run, validate this feature: wasm roundtrip tests for the caps
(including own-before-catch-up and the strict cap) and vitest property tests that run the picker
over many seeded sessions and check SC-003 and SC-006 on every run.

**Rationale**: Principle IV requires the sim for scheduling or algorithm changes. Neither is
touched: which verses a session serves is unchanged, extras are capped but stay New until graduated,
and the drill records nothing.

## D9. Single-book years leave the which-book card out of the drill

**Decision**: `memorize_session_v2` leaves a verse's `VerseInBook` card out of its `cardIds` (the
cards drilled with the verse) when the year's deck draws every verse from one book. Whether a deck
is single-book stays decided in core, where core 0.13.0 (`feat/single-book-ref`) already decides it
to seed the book tests at maximum memory. Core owns one rule for which tests are a given (today the
book of a verse in a single-book deck), used by that seeding and by `ReviewEngine::is_given(&Card)`,
true when every test a card asks is a given; the session builder skips any card it holds true for,
with no match on the card's kind. The card is not removed: `graduate_verse` flips every
bulk-graduable card of the verse, listed or not, so it still enters review with the verse.

**Rationale**: `cardIds` is already documented as "verse-bound cards drilled with this verse", so
omitting the card from it is the whole change for both consumers, and the web picker needs no
special case. One owner for "single-book" keeps the seeding and the drill from disagreeing about
which years qualify.

**Alternatives considered**: Filtering `VerseInBook` in the web picker, which would restate the
single-book rule in the client (Principles II and VII). A public `single_book` flag on the engine
with the session builder matching `VerseInBook` against it, as first implemented: core owned the bit
but not the rule, so the builder restated which card the bit makes a given. Leaving the card in and
relying on its max-memory seed, which still makes the learner answer a question with one possible
answer.

**Dependency**: core 0.13.0, merged to master in `4e9ca4c`; this feature's core bump lands on top of
it.
