# Research: Memorize by Schedule

**Date**: 2026-09-24 | **Plan**: [plan.md](./plan.md)

Nine decisions, each resolved against the current code in `crates/core/src/schedule.rs` and
`crates/core/src/schedule_data.rs`.

## D1. One classification of every un-memorized verse

**Decision**: A single core function places each un-memorized verse of an enabled club into one of
three buckets: **owed** (the schedule assigned it in a week that has started), **ahead** (assigned
in week `w`, which has not started), or **unscheduled** (never assigned). `memorize_debt` counts the
owed bucket; `next_memorize_batch` serves owed, else ahead by week, else unscheduled. Neither
function decides membership on its own.

To place a verse, the schedule is walked once to build a map from `(book, chapter, verse)` to the
first week that assigns it under any enabled club, borrowing book names from the schedule as
`for_each_cumulative_ref` does. Each un-memorized verse is then looked up by its render reference.

**Rationale**: FR-001 requires one definition. Two functions that each compute "owed" is how the
count and the queue drifted apart in the first place. The map is built from the schedule (a few
hundred refs) rather than from the deck, so it avoids `build_verse_lookup`'s per-verse `String`
clone over the whole deck, which `memorize_debt` already avoids for the same reason: it runs on
every `/api/years` request.

The first week that assigns a ref wins. It is what "owed since week `w`" means, and it keeps a verse
listed twice (a quirk of hand-made schedules) in one bucket.

**Alternatives considered**:

* _Keep `memorize_debt` as is and teach the queue to reproduce it_. Two implementations of one
  definition, the exact failure this feature fixes.
* _A per-week `Vec<VerseRef>` via `week_verse_refs`_. Clones a book name per ref per call; the map
  gives the same answer with one pass and borrowed keys.

## D2. Gates rank clubs instead of filtering them

**Decision**: `compute_eligible_clubs` is deleted. A new `club_ranks` walks the enabled clubs in
`ClubTier::ALL` order and gives each a rank equal to the number of unmet gates on the chain above
it, using the existing `gate_is_open` unchanged. Rank sorts before deck order, so a club behind an
unmet gate comes after the club above it, and nothing is removed.

**Rationale**: FR-006. `gate_is_open` already encodes every gate's condition correctly; only what an
unmet gate _does_ changes, so the conditions are reused verbatim. `compute_eligible_clubs` has one
production caller (`next_memorize_batch`) after core 0.11.0, so nothing else depends on the filter.

A gate that can never open (checkpoint gates with no schedule, `FullyMemorized` over an empty club)
now only ranks, so it can no longer strand verses. This closes the "count above zero, nothing to
serve" case by construction (FR-007).

**Alternatives considered**: _Keep eligibility and add a fallback when the eligible set is empty_. A
special case layered on the filter; a club held back while the higher club still had owed verses
would still be hidden from working ahead.

## D3. Sort order

**Decision**: Within each bucket, verses sort by these keys, first key first:

| Bucket      | Keys                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Owed        | club rank, then (for a club on calendar cascade) current-week verses before earlier ones, then deck position (`verse_id`) |
| Ahead       | week, then club rank, then deck position                                                                                  |
| Unscheduled | club rank, then deck position                                                                                             |

The batch takes up to `batch_size` verses from the first non-empty bucket of owed, ahead and
unscheduled, and never mixes them. Working ahead is a choice the learner makes by pressing Memorize
with nothing owed; topping up a short owed batch with next week's verses made that choice for them,
and hid where what they owed ended (product owner, 2026-10-01).

**Rationale**: FR-002, FR-003, FR-004, FR-009 and the product owner's answers: deck order within the
owed set, calendar cascade meaning "this week first". Club rank comes before the cascade key: the
cross-club gate expresses which _club_ to focus on, calendar cascade how a club orders _its own_
backlog, so the club-level choice outranks the within-club one. The approved FR-003 lists the two
rules the other way round; it is amended to match (see plan).

A verse is "current week" for the cascade key when its first assigning week is the current week. The
key reorders a club's owed verses only among the places that club's verses hold, so one club's
catch-up setting never moves another club's verses.

**Alternatives considered**:

* _Cascade key first_. A gated lower club on calendar cascade would then put its current week ahead
  of the higher club's backlog, which defeats the gate.
* _Cascade key across the rank_, sorting every club's owed verses by (rank, cascade key, verse id).
  A club on calendar cascade would then move its current week ahead of another club's backlog in the
  same rank, so a per-club setting reorders other clubs.

## D4. Before the season starts

**Decision**: With a schedule whose first week has not begun, nothing is owed: `memorize_debt`
returns zero and the queue goes straight to the ahead bucket, starting at week 0. The whole-pool
fallback remains only for "no schedule at all".

**Rationale**: FR-011. `current_week_index` already returns `None` before the season; D1 makes every
scheduled verse _ahead_ in that state without a special case. Only `memorize_debt`'s current
fallback branch changes.

## D5. The soft cap goes

**Decision**: Phase 1 and its overflow are removed. `batch_size` is a firm limit for every club.
`CatchUp::CalendarCascade` survives only as the D3 sort key; `CatchUp::Sequential` is its absence.
The stored setting and its wire shape are unchanged.

**Rationale**: FR-008, FR-009. With the owed set ordered once, "this week's primary" is a sort key,
not a separate phase, and a firm limit keeps SC-006 checkable.

## D6. Contract versions and surfaces

**Decision**: Core and wasm go to **0.12.0** (MINOR). No wasm export changes signature or JSON
shape: `memorize_session_v2(limit, now_secs)` and `memorize_debt(now_secs)` keep their arguments and
return shapes; their results change. The api (0.1.43) and web (0.9.24) bump to ship the new engine,
since both run it: the api's `/api/cards/memorize/session` route and the web's local
`engineStore.memorizeSession`.

**Rationale**: Principle III. Replay and the wire shape are unchanged, so not MAJOR; the observable
order and count change, so not PATCH.

## D7. Validating with the simulator

**Decision**: `crates/sim` gains a season memorize mode (`--memorize`). It walks each bundled season
day by day, from the first week's date to 14 days past the last, over every combination of:

* **Season**: the four decks with bundled schedules (GEPC 2023-24, NT Survey 2024-25, Corinthians
  2025-26, John 2026-27).
* **Gates**: the production John setting (`p150To300: always`, `p300ToFull: caughtUp`), and each of
  the five gate conditions applied to both pairs.
* **Catch-up**: every club sequential, and every club on calendar cascade.
* **Batch size**: 1 and 5.
* **Learner**: on plan (each week's quota spread exactly across its seven days), behind (the same
  pace with two mid-season weeks skipped), and ahead (twice the pace). No learner memorizes after
  the last week's seven days. A learner presses Memorize until it has memorized its budget for the
  day, memorizing served verses in batch order and leaving the rest of a batch for the next press.
  An overfilled batch therefore counts as a failure but buys no extra progress, so the current
  queue's soft cap cannot flatter its baseline.

The mode models no reviews. Neither `memorize_debt` nor `next_memorize_batch`, nor any gate, reads
memory state: they read which verses are memorized and the schedule. A review loop would add runtime
and random noise without changing any result the mode checks.

The sim holds no definition of "owed": that would be a second copy of the placement rule in a
consumer. It reads ownership off `memorize_debt` instead, watching the count as the learner
memorizes each served verse in batch order. An owed verse drops it by exactly one; any other verse
leaves it alone. Owed verses come first in a batch, so the count stays meaningful through the whole
batch.

* **SC-001, SC-003**: while `memorize_debt.verses > 0`, the batch is non-empty; at zero, memorizing
  a served verse leaves the count at zero.
* **SC-005**: while the count is above zero, the next verse in the batch drops it by one.
* **SC-006**: no batch is larger than the batch size.
* **SC-002**: while the count is zero, each served verse comes from the nearest week that still has
  un-memorized verses, read from the schedule as data.
* **SC-004**: verses memorized by season end, and the mean wait: days from the date of the week that
  first assigns a verse to the day it is memorized, zero for a verse memorized ahead, and counted up
  to the last day walked for a verse never memorized.

The mode lands first, against the current queue. `--out` writes every season, setting and learner's
outcome to `sim-baseline.tsv` beside this file, and the totals go in `quickstart.md`. The core
change then reruns the same mode with `--baseline sim-baseline.tsv`: no invariant fails in any
combination, and in every combination the verses memorized are at least the baseline and the mean
wait no longer. Comparing per combination keeps a regression in one setting from hiding in a total;
the mode has no randomness, so the comparison is exact. The mode also times `memorize_debt` and
`next_memorize_batch`, so the run doubles as the no-regression check for D9.

An earlier draft also ran the existing `ProbLearner` review loop and compared mean retrievability at
season end. It measured the review capacity rather than the queue: at 100 reviews a day every
learner ended near 0.78, at 1000 near 0.985, with no difference between learners at either setting.

**Rationale**: Principle IV requires simulator validation for a scheduling change, and today's sim
graduates every card up front, so it cannot see the memorize queue at all. Running one sim harness
against both queues, rather than keeping a copy of the old algorithm in the sim, avoids
reimplementing engine logic in a consumer (Principle II).

**Alternatives considered**:

* _Freeze a copy of the old queue inside the sim for side-by-side runs_. Engine logic in a consumer.
* _Depend on core 0.11.0 from git as a second crate_. Works, but pins the sim to a network fetch and
  a tag for a one-off comparison.

## D8. Where the design lives

**Decision**: A new `docs/memorize.md` becomes the owning doc for the memorize queue and count:
owed, ahead and unscheduled, sort keys, gates as ranking, calendar cascade, batch size, and the
no-schedule and pre-season cases. `CLAUDE.md`'s reference-docs list gains it, and
`docs/unspecced.md`'s "Memorize schedules" entry is narrowed to what stays undocumented (the
schedule data model and editor). The 2026-06-14 superpowers design doc is left untouched.

**Rationale**: FR-014 names the superpowers doc, but `docs/superpowers/` is read-only history
(`CLAUDE.md`), and `docs/unspecced.md` already records that the memorize schedule has no owning doc.
Principle I makes docs in `docs/` the source of truth, so the behaviour belongs there. FR-014 is
amended to name the new doc.

## D9. Cost

**Decision**: No budget beyond "no regression". The classification pass is one walk of the schedule
(≈ 32 weeks × ≈ 15 refs) plus one lookup per un-memorized verse in enabled clubs, per call. It
replaces `compute_eligible_clubs`, whose gates each ran `tier_memorize_progress` over every card.
`club_ranks` still calls `gate_is_open`, so that cost remains once per enabled club.
