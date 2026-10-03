# Data Model: Memorize Session Flow

No persisted shape changes. The entities below live for one session, in memory.

## Session (per enrolled year)

Built by `memorize_session_v2(limit, now_secs)`; JSON shape unchanged (`{ verses, orphans }`, see
[contracts/memorize-session.md](./contracts/memorize-session.md)).

| Part                         | Bound                                                          | Source                                  |
| ---------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| verses                       | at most `limit`                                                | `next_memorize_batch` (unchanged)       |
| a verse's `cardIds`          | its new cards, minus the which-book card in a single-book year | builder; `is_given` from core           |
| heading + chapter-list cards | at most `limit` in total, own before catch-ups                 | `hpCardId`/`cclCardId` slots, `orphans` |
| orphans                      | at most `limit` in total, from memorized verses                | `orphans`                               |

`limit` is the year's `lessonBatchSize`. A multi-year session is the concatenation of each serving
year's session, so every bound holds per year.

**Own vs catch-up**: a heading or chapter-list card is _own_ when it attaches to a session verse by
FR-008 (first heading member in session order; last chapter member once the chapter and tier are
settled). Otherwise it is a _catch-up_.

## Session item

A verse (all its new cards) or one standalone card (heading, chapter list, or orphan). Unchanged
from today: read phase, drill, closing read, graduate or "Not yet".

## Drill card

| Field  | Meaning                                                            |
| ------ | ------------------------------------------------------------------ |
| item   | the session item it belongs to; graduating an item drops its cards |
| verse  | material + render verse id; the no-echo key (research D3)          |
| stage  | `blank`, `whole` (Recitation, Ftv), or `other`                     |
| phrase | the blank's phrase position; blanks only                           |
| shown  | blanks only: shown at least once (a missed blank stays shown)      |

**States**: left → shown → (Again: left, still shown) → Good: done. A drill ends when no card is
left; its cards' items then go to the closing read.

**Eligibility per verse**: unshown blanks are eligible in phrase order, one at a time; a missed
blank is eligible as itself; whole-verse cards are eligible once every blank is Good. The swap table
in research D2 maps any draw onto an eligible card.
