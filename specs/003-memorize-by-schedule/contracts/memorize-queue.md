# Contract: Memorize Queue and Count

**Status**: target state for this feature. Contract crates go to core 0.12.0 and wasm 0.12.0.

No signature or JSON shape changes at any boundary. What changes is the result of two functions, and
every consumer that calls them.

## Core

```rust
pub fn memorize_debt(engine: &ReviewEngine, schedule: Option<&Schedule>, now_secs: i64) -> MemorizeDebt
pub fn next_memorize_batch(engine: &ReviewEngine, schedule: Option<&Schedule>, now_secs: i64, batch_size: u8) -> Vec<CardId>
```

Both read the same placement of un-memorized verses ([data-model.md](../data-model.md)):

* `memorize_debt` counts the owed verses, or with no usable schedule (none bound, or one that
  assigns the deck nothing) the whole enabled pool. Zero before the season's first week.
* `next_memorize_batch` returns at most `batch_size` anchor cards of one kind: owed if anything is
  owed, else ahead by week, else unscheduled. While `memorize_debt(..).verses > 0`, the batch is
  non-empty and every verse in it is owed (FR-004).

Removed: `compute_eligible_clubs` (private) and `Schedule::for_each_cumulative_ref` (public). Added:
`club_ranks` (private), the placement pass (private), and `Schedule::for_each_ref` (public), which
visits each ref a tier introduces with its week's index. `ClubTier::ALL` and `anchor_card_for_verse`
are unchanged.

## Wasm

| Export                                 | Arguments | Result shape                     | Change                                                                                                                                                                                                    |
| -------------------------------------- | --------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memorize_session_v2(limit, now_secs)` | unchanged | `{ verses, orphans }`, unchanged | Verses follow the new order; `limit` is a firm cap                                                                                                                                                        |
| `memorize_session(limit)`              | unchanged | unchanged                        | Deprecated, no callers. It calls v2 with `now_secs = 0`, which now reads as before the season: with a bound schedule it serves in schedule order from the first week, without one in deck order as before |
| `memorize_debt(now_secs)`              | unchanged | `{ verses, cards }`, unchanged   | Zero before the season starts                                                                                                                                                                             |

## API

No route or payload changes. `GET /api/cards/memorize/session` and `GET /api/years` (`memorizeDebt`)
return results under the new rules once the api ships core 0.12.0.

## Web

No request or type changes. `engineStore.memorizeSession` runs the local wasm engine and follows the
new order once web ships wasm 0.12.0.
