# Feature Specification: Memorize by Schedule

**Feature Branch**: `feat/memorize-by-schedule`

**Created**: 2026-09-24

**Status**: Approved 2026-09-24; amended 2026-10-01 (SC-002, SC-004, FR-001, FR-004, FR-012, FR-013)

**Input**: User description: "The memorize queue should serve from the schedule, not from deck
order. The count is what the schedule has asked for through the current week, un-memorized, across
every club with memorize enabled. The queue should serve exactly that set first, and memorizing
ahead should be 'pretend it is a week (or more) later' until the lesson batch is filled. One
mechanism for both, so the count and what Memorize hands out can never disagree. The cross-club
gates decide order within the set, never remove verses from it."

## Why This Exists

A learner sees two things about new verses: a number ("57 to memorize") and a button (Memorize).
Today they come from two different rules. The number is what the season's schedule has asked for so
far. The button walks each allowed club's whole pool in deck order and ignores the schedule. The two
usually overlap, but not always:

* The schedule sometimes introduces verses out of deck order. John's first week lists Club 300
  verses from later in chapter 1 (1:22-27), which deck order hands out a week late.
* Working ahead ignores the calendar entirely: it serves the next verse in the deck, not next week's
  assigned verses.
* Under some cross-club settings the number can be above zero while the button has nothing to give,
  and the empty page then tells the learner to switch on a club that is already on.

The rule this feature adopts is the one a learner would state themselves:

> Memorize hands out what the schedule has asked for so far. Memorizing ahead is pretending it is
> next week.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - The button serves what the number counts (Priority: P1)

A learner who is behind presses Memorize and gets verses the schedule has already asked for, in deck
order. Each one they finish lowers the number by one, and the number reaches zero exactly when there
is nothing more owed.

**Why this priority**: This is the disagreement the learner can see. A number that the button does
not work down reads as broken, and a verse the schedule has already assigned should not wait behind
verses it has not assigned yet.

**Independent Test**: With a learner behind by two weeks, press Memorize repeatedly and confirm
every verse served was already owed, served in deck order, and that the number drops by the verses
finished each time.

**Acceptance Scenarios**:

1. **Given** a learner who is two weeks behind, **When** they press Memorize, **Then** every verse
   they are given was assigned by the schedule in a week that has already started.
2. **Given** owed verses from several weeks, **When** the learner works through them, **Then** they
   receive them in deck order.
3. **Given** the number reads N, **When** the learner memorizes k of the owed verses they were
   given, **Then** the number reads N minus k.
4. **Given** a week lists a verse out of deck order (John's first week lists 1:22-27), **When** that
   week has started, **Then** the verse is owed and served among the owed verses, before any verse
   from a week that has not started.

---

### User Story 2 - Memorizing ahead means next week's verses (Priority: P1)

A learner who is caught up presses Memorize and gets next week's assigned verses, as if it were
already next week. If next week has fewer than they asked for, the week after follows, and so on.

**Why this priority**: Working ahead is how a caught-up learner uses the app, and the schedule is
the plan they are working ahead on. Deck order is a poor stand-in for it.

**Independent Test**: With a learner exactly on plan, press Memorize and confirm the verses served
are the next week's assigned verses; with a batch larger than one week's list, confirm the following
week fills the remainder.

**Acceptance Scenarios**:

1. **Given** a learner with nothing owed, **When** they press Memorize, **Then** they get verses
   from the nearest week the schedule has not reached that still has un-memorized verses.
2. **Given** the next week lists fewer verses than the batch size, **When** they press Memorize,
   **Then** the batch continues into the week after, until it is full or the schedule runs out.
3. **Given** the next week is a review week with no new verses, **When** they press Memorize,
   **Then** it is skipped and the following teaching week supplies the verses.
4. **Given** a learner memorizing ahead, **When** they finish, **Then** the number stays at zero:
   verses taken from future weeks are not owed yet, so they never add to it.

---

### User Story 3 - Cross-club settings order the work, they never hide it (Priority: P2)

A learner uses the "move to the next club" settings to focus on a higher club first. Those settings
now decide which owed verses come first. They never make owed verses disappear from the queue while
the number still counts them.

**Why this priority**: The settings exist to express priority. Treating them as a filter is what
lets the number and the button disagree.

**Independent Test**: With Club 300 owed verses and a closed gate from Club 150, confirm Club 150's
owed verses are served first, then Club 300's, and that the queue is never empty while the number is
above zero.

**Acceptance Scenarios**:

1. **Given** a gate from a higher club to a lower club is not yet met, **When** both have owed
   verses, **Then** the higher club's owed verses are served before the lower club's.
2. **Given** the higher club has no owed verses left, **When** the learner presses Memorize,
   **Then** the lower club's owed verses are served, even though its gate is still not met.
3. **Given** the number is above zero, **When** the learner presses Memorize, **Then** they are
   given at least one verse. The empty page is never shown while work is owed.

---

### User Story 4 - "This week first" keeps pace with the group (Priority: P3)

A learner who is behind but wants to keep up with the group's current week sets a club's catch-up to
"calendar cascade". That club's verses for the current week then come before its older backlog.
Nothing else about the setting changes what they are given.

**Why this priority**: It is the one choice the catch-up setting still expresses once every club
follows the schedule, and it matters only to learners who are behind.

**Independent Test**: With a learner two weeks behind and a club on calendar cascade, press Memorize
and confirm that club's current-week verses come first, then its backlog in deck order; switch the
club to sequential and confirm the backlog comes first.

**Acceptance Scenarios**:

1. **Given** a club on calendar cascade and a learner behind, **When** they press Memorize, **Then**
   that club's owed verses from the current week are served before its owed verses from earlier
   weeks.
2. **Given** a club on sequential, **When** the learner is behind, **Then** its owed verses are
   served in deck order, whatever week they come from.
3. **Given** a club on calendar cascade with more current-week verses than the batch size, **When**
   the learner presses Memorize, **Then** they get a batch of exactly the batch size, not the whole
   week.
4. **Given** a learner who is caught up, **When** they press Memorize, **Then** the catch-up setting
   makes no difference: both options work ahead into next week.

---

### Edge Cases

* **No schedule for the year.** There is no calendar to follow: the queue serves every un-memorized
  verse in the enabled clubs in deck order after the cross-club rule (FR-006), and the number is
  that whole pool, as today. A bound schedule that assigns none of the deck's verses under an
  enabled club (no weeks, or rows from another book) counts as no schedule.
* **Before the season starts.** Nothing is owed yet, so the number is zero. Pressing Memorize works
  ahead into the first week, then the second, as for any learner who is caught up.
* **After the season ends.** The final week is the current week, so the whole season's schedule is
  owed. Once it is all memorized, any enabled-club verses the schedule never assigned are served in
  deck order.
* **Review weeks.** They assign nothing. They do not add to the number and are skipped when working
  ahead.
* **A verse the schedule files under a different club than the deck does.** It is owed if the
  schedule assigns it in any enabled club and its own club has memorize enabled, the rule the number
  already uses.
* **A verse a printed row moves to another week.** Not fully explored. Today the earliest week that
  assigns it under any memorized club wins, Full's passage range included; whether a quizzer
  memorizing Full straight through should follow the passages instead is open (#173). See the open
  question in `docs/memorize.md`.
* **A club with memorize switched off.** Its verses are neither counted nor served.
* **Batch larger than what is owed.** The batch holds only the owed verses; working ahead starts
  with the next press, in a batch of its own. No batch is padded with verses from switched-off
  clubs.
* **A learner edits their schedule.** Owed and ahead are computed from the edited schedule the next
  time they press Memorize.

## Requirements _(mandatory)_

### Functional Requirements

* **FR-001**: The verses owed MUST be defined once: the un-memorized verses the schedule assigned in
  weeks that have started, in every club with memorize enabled. With no schedule, every un-memorized
  verse in those clubs stands in for the owed verses (FR-010). The number shown to the learner and
  the first verses Memorize serves MUST both use this definition.
* **FR-002**: Memorize MUST serve owed verses before any verse that is not owed.
* **FR-003**: Owed verses MUST be served in deck order, subject to two rules that come first, in
  this order: a club behind an unmet cross-club gate comes after the club above it (FR-006), and
  within a club, calendar cascade serves its current-week owed verses before its other owed verses
  (FR-009).
* **FR-004**: When nothing is owed, Memorize MUST work ahead as if the calendar had moved forward:
  the nearest future week that still has un-memorized verses, then the week after, until the batch
  is full or the schedule is exhausted. Within a future week, verses come in deck order, with the
  same cross-club rule. A batch MUST NOT mix owed and ahead verses: while anything is owed it holds
  only owed verses, even when fewer than the batch size, and working ahead starts with the next
  press.
* **FR-005**: Verses taken from future weeks MUST NOT change the number shown. It counts only weeks
  that have started.
* **FR-006**: A cross-club gate that is not met MUST place the lower club's verses after the higher
  club's within the same set (owed, or one future week), and MUST NOT remove them from it.
* **FR-007**: While the number is above zero, Memorize MUST serve at least one verse.
* **FR-008**: The batch size MUST be a firm limit for every club. Calendar cascade no longer
  includes a whole week's verses past the batch size.
* **FR-009**: The per-club catch-up setting MUST keep exactly one meaning: "calendar cascade" puts
  that club's current-week owed verses first; "sequential" does not. It MUST have no effect when
  nothing is owed.
* **FR-010**: With no schedule, the queue MUST serve every un-memorized verse in the enabled clubs
  in deck order, subject to the cross-club rule (FR-006), and the number MUST count that whole pool.
* **FR-011**: Before the season's first week, the number MUST be zero, and Memorize MUST work ahead
  into the first weeks.
* **FR-012**: Once every scheduled verse in the enabled clubs is memorized, verses the schedule
  never assigned MUST still be served, in deck order subject to the cross-club rule (FR-006), in
  batches of their own.
* **FR-013**: The change MUST be validated against simulated learners before shipping, comparing the
  new queue with the current one on learners who are on plan, behind, and working ahead, across
  every bundled season and the cross-club, catch-up and batch-size settings.
* **FR-014**: A design document in `docs/` MUST describe this behaviour in the same change. The
  2026-06-14 schedules design is read-only history, so the behaviour gets its own owning document
  instead of an edit there.

### Key Entities

* **Schedule week**: A dated row assigning verses to clubs. Teaching weeks assign verses; review
  weeks assign none.
* **Owed verses**: Un-memorized verses the schedule assigned in weeks that have started, in enabled
  clubs, or every un-memorized verse in those clubs when there is no schedule. What the number
  counts and what Memorize serves first.
* **Ahead verses**: Un-memorized verses assigned in weeks that have not started. Served only once
  nothing is owed, nearest week first; never counted.
* **Cross-club gate**: A per-year setting between adjacent clubs. It now ranks the lower club's
  verses after the higher club's until its condition is met.
* **Catch-up setting**: A per-club choice. Calendar cascade means "this week first" when behind;
  sequential means "deck order" when behind.

## Success Criteria _(mandatory)_

### Measurable Outcomes

* **SC-001**: In every simulated learner state, the number is above zero exactly when pressing
  Memorize would serve an owed verse, with no exceptions.
* **SC-002**: For any learner with nothing owed, working ahead serves verses from the nearest future
  week that still has un-memorized verses, in 100% of cases.
* **SC-003**: No learner is ever shown the empty Memorize page while the number is above zero.
* **SC-004**: In every simulated season, setting and learner, the new queue memorizes at least as
  many verses by season end as the current queue, and a verse waits no longer on average between
  becoming owed and being memorized.
* **SC-005**: A learner who is behind never receives an un-owed verse while any owed verse remains.
* **SC-006**: No memorize session is ever larger than the learner's batch size.

## Assumptions

* The number shown (the memorize debt) already follows FR-001 as of core 0.11.0, except before the
  season starts, where it currently reports the whole pool. FR-011 changes that case.
* "Deck order" is the order verses appear in the deck, which is also the order the printed schedule
  lists them within a passage.
* Cross-club gates keep their current conditions (fully memorized, checkpoints, caught up, always);
  only what an unmet gate does changes.
* The catch-up setting keeps its current labels, which already describe its remaining meaning
  ("Sequential (next un-memorized verse)", "Calendar cascade (this week first, then backlog)").

## Out of Scope

* Changing how many verses a session holds by default, or the lesson batch size setting.
* Changing the review queue, or how memorized verses are scheduled for review.
* Changing the schedule editor or the bundled schedules.
* The home page's "work ahead" wording, beyond keeping it true under the new rule.
