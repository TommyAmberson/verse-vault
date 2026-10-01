# Memorize

How the engine decides which new verses to hand out, and how many it says are waiting. Reviewing
memorized verses is a separate queue; see [`scheduling.md`](scheduling.md). Within a memorize
session see [`session.md`](session.md). The design and its validation live in
[`specs/003-memorize-by-schedule/`](../specs/003-memorize-by-schedule/).

The rule a learner would state is the rule the engine follows:

> Memorize hands out what the schedule has asked for so far. Memorizing ahead is pretending it is
> next week.

## One placement, read twice

A learner sees a number ("57 to memorize") and a button (Memorize). Both come from one function,
`place_unmemorized` in `crates/core/src/schedule.rs`, so they cannot disagree about what is owed.

It places every un-memorized verse whose own club has memorize enabled:

| Placement   | Meaning                                      | Counted | Served               |
| ----------- | -------------------------------------------- | ------- | -------------------- |
| Owed        | first assigned in a week that has started    | yes     | first                |
| Ahead       | first assigned in a week that hasn't started | no      | once nothing is owed |
| Unscheduled | no week assigns it                           | no      | last                 |

A week **assigns** a verse when its row lists it under any enabled club, Full's range included (the
passage minus the row's Club 150 and Club 300 lists). So a verse the schedule files under a
different club than its deck tag still places, as long as its own club is enabled. The first week to
assign a verse wins, which keeps a verse a schedule lists twice in one bucket. How that plays out
for verses a printed row moves to another week is not settled; see
[Open question](#open-question-verses-a-row-moves-to-another-week).

`memorize_debt` counts the owed verses and the `New` cards they carry. `next_memorize_batch` serves
from the same placement.

## The queue's order

The queue has three buckets, in this order. A batch takes up to `batch_size` verses from the first
bucket that has any, and never mixes buckets: while anything is owed the batch holds only owed
verses, even when fewer than `batch_size`, and working ahead is the next press.

1. **Owed**, by club rank, then deck order. A club on calendar cascade then puts its own this-week
   verses ahead of its older ones, in the places its verses already hold.
2. **Ahead**, nearest week first, then club rank, then deck order. This is "pretending it is next
   week": with nothing owed, a learner gets next week's list, and a batch larger than that week
   continues into the week after. Review weeks assign nothing and drop out on their own.
3. **Unscheduled**, by club rank, then deck order.

`batch_size` is a firm limit for every club.

### Cross-club gates rank clubs

The `move_to_next` gates (`p150To300`, `p300ToFull`) keep their conditions: always, caught up, after
a minor or major checkpoint, fully memorized. What an unmet gate does changed: it ranks the lower
club after the higher one, and never removes its verses. `club_ranks` gives each enabled club the
number of unmet gates on the chain from the top enabled club down to it, each gate read against the
nearest enabled club above.

So a gate decides which club to focus on, and the queue still serves the lower club once the higher
one has nothing owed, gate met or not. A gate that can never open (a checkpoint gate with no
schedule, fully memorized over an empty club) only orders. While the count is above zero the queue
is never empty.

### Calendar cascade is "this week first"

A club's catch-up setting reorders its own owed backlog. On calendar cascade, its owed verses from
the current week come before its older ones; on sequential, deck order. Rank comes first: a gate
picks the club to focus on, calendar cascade orders that club's backlog. With nothing owed the
setting makes no difference.

## Seasons and their edges

* **No schedule.** There is no calendar, so every un-memorized verse in the enabled clubs stands in
  for the owed verses: counted, and served in rank then deck order. A bound schedule that assigns
  the deck nothing under an enabled club (no weeks, or rows from another book) counts as none.
* **Before the first week.** Nothing is owed, so the count is zero, and the queue works ahead from
  the first week.
* **After the last week.** The final week stays current, so the whole season is owed. Once it is all
  memorized, the verses no week assigns are served in rank then deck order.
* **A club with memorize off.** Its verses are neither counted nor served, and it has no rank.
* **An edited schedule.** Placement is computed on every call, so an edit applies on the next one.

## The count and the queue

While the count is above zero, the batch is non-empty and every verse in it is owed; memorizing one
drops the count by one. At zero the queue may still have verses: a learner on plan can work ahead.
Callers rendering the zero state should say so.

The count is computed by the api (`memorizeDebt` on `GET /api/years`) and the queue by the web
client's own engine. They agree when both run the same core version. During a release, a client
still on an older web build can serve under the old engine while the count comes from the new api,
until its next page load.

The memorize simulation (`cargo run -p verse-vault-sim --release -- --memorize`) checks these
properties across every bundled season and setting; see
[`specs/003-memorize-by-schedule/quickstart.md`](../specs/003-memorize-by-schedule/quickstart.md).

## Open question: verses a row moves to another week

Not fully explored, and tracked in [#173](https://github.com/TommyAmberson/verse-vault/issues/173).
This section records what the code does today; it is not a decision that the behaviour is right.

Printed schedules sometimes list a club verse in a different week from the passage that contains it.
On John 2026-27, week 0 (John 1:1-18) leaves Club 150 verses 1:17-18 to week 1's Club 150 list, and
pulls Club 300 verses 1:22, 23, 26 and 27 forward from week 1's passage (1:19-51) into its own Club
300 list. GEPC 2023-24 does the same with Philippians 2:11 and 2:13-15, which its week 21 passage
contains and week 22's Club 150 list names.

Placement takes the earliest week that assigns a verse under any club the learner memorizes, where
Full's assignment is the passage minus the row's Club 150 and 300 lists. Today that gives:

| Memorize enabled for   | 1:17-18 (Club 150) | 1:22-27 (Club 300) |
| ---------------------- | ------------------ | ------------------ |
| Club 150 only          | week 1             | not memorized      |
| Club 150 and 300       | week 1             | week 0             |
| Club 150, 300 and Full | week 0             | week 0             |

What is open:

* A quizzer memorizing Full straight through might expect to follow the passages, which would put
  1:22-27 in week 1 for them. A quizzer working Club 300 first and then Full would follow the club
  lists. Whether the move-to-next gates (for example `p300ToFull: always`) are what tells the two
  apart is not decided.
* When a quizzer working Club 300 first and then Full should meet 1:17-18: in week 1, through the
  Club 150 list, or in week 0, through Full's range as today.
* Any change here would move the count and the queue, and may need to move the gates' cumulative
  counts too, since they count Full the same way.
