# Feature Specification: Memorize Session Flow

**Feature Branch**: `feat/memorize-session-flow`

**Created**: 2026-10-02

**Status**: Draft (clarified 2026-10-02: extras caps, drill order, single-book drill)

**Input**: User description: "The memorize session flow: what happens from pressing Memorize to the
verses being memorized. Today the web Memorize page runs its own three phases (read every item,
drill every card in one shuffled queue with each verse's blanks before its recitation and FTV, then
read again and graduate each item), while docs/session.md documents a core progressive reveal
(Reading, PhraseFill 0..N-1, Recitation) that no client uses. Around it sits behaviour with no
owning doc: how many and which extra cards a session carries, 'Already memorized' during reading,
what Again does, how multiple enrolled years combine, and how a session ends. The spec should record
the current flow as the baseline and decide the adjustments worth making."

## Context

Which verses a session introduces is owned by `docs/memorize.md` (the memorize queue). What the
learner then does with them is owned by nothing. This spec covers that second half: the session from
pressing Memorize to the verses being memorized.

### Baseline: the flow today (web 0.10.3)

A session is built when the learner opens the Memorize page:

* **Verses.** Each enrolled year with memorize enabled contributes up to its lesson batch size of
  verses from the memorize queue. While any year owes verses, only the years that owe verses
  contribute, so a session never mixes owed and work-ahead verses.
* **A verse's cards.** Every new card of the verse: its blanks (one per phrase), its full
  recitation, its citation and reference cards, and the optional cards its settings turn on (first
  words, which club, which heading).
* **Extra cards.** Cards not tied to one of the session's verses ride along as their own items, in
  two groups:
  * **Heading and chapter-list cards.** A heading's passage card goes with the first of its verses
    in the session, and a chapter's club-list card with the last of its verses once every verse of
    that chapter and club is memorized or in the session. Either can also ride along as a catch-up
    on any session verse with room, when its verses were memorized earlier.
  * **Orphans.** Optional cards (first words, which heading, which club) still new on verses
    memorized earlier, for example a first-words card switched on after the verse was memorized.
    Since web 0.10.2 these come only from memorized verses.

  Each kind of extra is capped at the batch size separately, so a batch of 3 can carry up to about
  15 extras alongside 3 verses. A real session on 2026-10-02 carried 3 verses and 6 extras.
* **No verses.** When nothing is left to introduce, the session can still be made of extras alone.

The session then runs in three phases:

1. **Read.** The learner reads every item in turn: each verse as its full text, each extra card as
   itself. On any item they can say "Already memorized", which memorizes it at once and drops it
   from the rest of the session.
2. **Drill.** Every card of every remaining item goes into one shuffled queue. Within each verse,
   its blanks come before the cards that ask for the whole verse (its recitation and first-words
   card); other cards go anywhere. Each card is shown, revealed, and answered Again or Good. Again
   sends it to the back of the queue, and a missed blank takes its verse's whole-verse cards behind
   it. Good removes it. Drill answers are not recorded as reviews: memorize is an introduction, and
   memory tracking starts once a verse is memorized.
3. **Read again.** The learner walks the remaining items once more and, for each, chooses Graduate
   (memorized now) or Not yet (left unmemorized, offered again in a later session).

The session ends on a summary of how many verses were memorized, with a link to Review.

Separately, `docs/session.md` documents a core "progressive reveal" for a new verse (read it, then
each blank in order, then the recitation). No client uses it.

## Clarifications

### Session 2026-10-02

* Q: When two enrolled years both contribute to one session, does each extras cap apply per year or
  to the session as a whole? → A: Per year: each contributing year carries at most its own batch
  size of each group of extras (heading and chapter-list cards; orphans).
* Q: When the heading and chapter-list cards of the session's own verses exceed the batch size, does
  the cap hold or give way? → A: The cap holds; the leftover cards become catch-ups for a later
  session.
* Q: When every blank of a verse has been shown but some still wait after Again, and the pick lands
  on that verse's recitation or first-words card, what comes up instead? → A: The missed blank; if
  several are waiting, one of them at random.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - A session stays about its verses (Priority: P1)

A learner presses Memorize to learn a few new verses. The session leads with those verses. The
heading and chapter-list cards that belong with them come along, so those never fall behind, and the
rare orphans are cleared a few at a time without getting in the way: a batch of 3 verses never turns
into a session of 18 items.

**Why this priority**: Heading and chapter-list cards are normally memorized alongside their verses,
and orphans need catching up eventually, but today each kind is bounded on its own, so together they
can outweigh the verses the learner came for.

**Independent Test**: Build sessions for a learner with many heading, chapter-list and orphan cards
outstanding, and confirm each group stays within its cap, the session's own heading and chapter-list
cards come first, and orphans follow the verses.

**Acceptance Scenarios**:

1. **Given** a batch size of 3 and many outstanding extras, **When** the learner presses Memorize,
   **Then** the session holds 3 verses, at most 3 heading and chapter-list cards, and at most 3
   orphans.
2. **Given** heading and chapter-list cards for this session's verses and others waiting as
   catch-ups, **When** the cap is reached, **Then** the cards for this session's verses are the ones
   included.
3. **Given** orphans outstanding, **When** the learner reads through the session, **Then** the
   orphans come after their year's verses.
4. **Given** extras beyond either cap, **When** the learner finishes the session, **Then** the rest
   are offered in later sessions, none lost.
5. **Given** nothing left to introduce but extras outstanding, **When** the learner presses
   Memorize, **Then** they get a session of extras within the same caps.

---

### User Story 2 - The drill builds a verse up before asking for all of it (Priority: P1)

A learner drilling a session works through each verse's blanks in phrase order before being asked to
type the whole verse, from its reference or from its first words. The verses, their location cards
and the extras are mixed at random, the same verse never comes up twice in a row, and a missed blank
comes back at random later without holding the verse up. The drill is practice for getting a feel
for each verse: one Good is enough to be done with a card.

**Why this priority**: Asking for the whole verse before its phrases have been practised was the
reported problem. Web 0.10.1 keeps a verse's blanks before its whole-verse cards; this story settles
the rest of the drill: blanks in phrase order, no echo, and how misses come back.

**Independent Test**: Drill many sessions with a fixed random seed and confirm, for every verse,
that its blanks are first shown in phrase order, that its whole-verse cards come only after all of
its blanks are answered Good, and that no two cards in a row belong to the same verse while another
verse's cards remain.

**Acceptance Scenarios**:

1. **Given** a verse with three blanks, **When** the drill runs, **Then** its blanks are first shown
   in phrase order, interleaved with other cards.
2. **Given** the learner answers Again on blank 2, **When** the drill continues, **Then** blank 3
   can still come up, and blank 2 comes back later at random.
3. **Given** a verse whose blanks are not all answered Good, **When** the drill picks a next card,
   **Then** that verse's recitation and first-words card do not come up; once all its blanks are
   Good, they come up in either order.
4. **Given** a card from one verse was just shown, **When** another verse's card or an extra
   remains, **Then** the next card is not from the same verse.
5. **Given** several verses, location cards and extras, **When** the drill runs, **Then** they come
   up mixed at random rather than verse by verse.
6. **Given** a verse whose blanks have all been shown but one or more still wait after Again,
   **When** the pick lands on its recitation or first-words card, **Then** a waiting blank comes up
   instead, chosen at random if several wait.
7. **Given** a verse in a single-book year (John, Luke), **When** the drill runs, **Then** its
   which-book card does not come up, and it is still memorized with the verse at graduation.

---

### User Story 3 - The learner decides what is memorized (Priority: P2)

A learner can skip what they already know at the start and decline to memorize a verse at the end,
and the session respects both.

**Why this priority**: Graduation decides what enters the review queue, so the learner's say over it
must hold. This records today's behaviour as required.

**Independent Test**: Run a session marking one item "Already memorized" in the read phase and
another "Not yet" at the end; confirm the first is memorized at once and left out of the drill, the
second stays unmemorized and returns in a later session.

**Acceptance Scenarios**:

1. **Given** an item in the read phase, **When** the learner picks "Already memorized", **Then** it
   is memorized at once and does not appear in the drill or the closing read.
2. **Given** an item at the closing read, **When** the learner picks "Not yet", **Then** it stays
   unmemorized and the memorize count is unchanged for it.
3. **Given** every item was marked "Already memorized", **When** the read phase ends, **Then** the
   session ends without a drill.

---

### User Story 4 - One documented flow (Priority: P3)

Someone reading the docs to change the memorize session finds the flow the app actually runs, in one
place.

**Why this priority**: `docs/session.md` describes a progression no client uses, which misleads
anyone changing this code.

**Independent Test**: Compare the owning doc with the app's behaviour on each point in this spec.

**Acceptance Scenarios**:

1. **Given** the docs, **When** someone looks up how a memorize session runs, **Then** one owning
   doc describes the three phases, the drill order, the extras and their cap.
2. **Given** the core progressive reveal, **When** this feature ships, **Then** it is either what
   the app runs or no longer documented as the flow.

### Edge Cases

* **No verses to introduce.** A session of extras only, within the cap.
* **Own heading and chapter-list cards over the cap.** The cap holds; the leftover cards become
  catch-ups for a later session.
* **A verse with no blanks.** Its whole-verse cards are eligible from the start.
* **A verse with no whole-verse cards.** Its blanks still go in phrase order; nothing waits on them.
* **Only one verse's cards left.** No-echo cannot hold, so that verse's cards come up in a row.
* **Every item already memorized.** The session ends after the read phase.
* **Two enrolled years.** Each contributes up to its own batch size of verses, and up to its own
  batch size of each group of extras (heading and chapter-list cards; orphans); while any year owes
  verses, only owing years contribute (shipped in web 0.9.24). Each year's items read as one block:
  its verses with their heading and chapter-list cards, then its orphans.
* **Learner leaves mid-session.** Nothing is memorized that the learner didn't confirm; the verses
  come back next time.

## Requirements _(mandatory)_

### Functional Requirements

* **FR-001**: A session MUST introduce up to the batch size of verses per contributing year from the
  memorize queue, with no mixing of owed and work-ahead verses across years.
* **FR-002**: Each contributing year MUST carry at most its own batch size of heading and
  chapter-list cards in total, even when the session's own verses have more. Those belonging to the
  session's own verses MUST take precedence over catch-ups; any left out, the session's own or
  catch-ups, MUST be offered as catch-ups in a later session.
* **FR-003**: The read phase MUST show every item before any drilling and MUST let the learner mark
  any item "Already memorized", which memorizes it at once and removes it from the rest of the
  session.
* **FR-004**: The drill MUST present every card of every remaining item, including each verse's
  location cards, except the which-book card of a verse in a year whose deck draws every verse from
  one book. For each verse it MUST first show the blanks in phrase order, and MUST offer the verse's
  whole-verse cards (its recitation and its first-words card) only once all of its blanks are
  answered Good; those two then come up in either order.
* **FR-005**: The drill MUST pick each next card at random from the cards left, then swap a pick the
  verse is not ready for with one it is: a blank not yet shown, or a whole-verse card while blanks
  are still unshown, becomes the verse's next unshown blank in phrase order; a whole-verse card
  while every blank has been shown but some still wait after Again becomes a missed blank, chosen at
  random if several wait. Each verse is thus picked in proportion to every card it has left, apart
  from the verse just shown, and the result is a random mix that keeps each verse's build-up.
  Location cards and extras MUST be picked as themselves, with no special spacing.
* **FR-006**: Good MUST mean done drilling that card for the session. Again MUST return the card to
  the cards left, to come up again at random; a missed blank MUST NOT stop the verse's next blanks
  from coming up. Drill answers MUST NOT be recorded as reviews.
* **FR-013**: The drill MUST NOT show two cards from the same verse in a row while another verse's
  card or an extra remains.
* **FR-007**: The closing read MUST offer every remaining item for graduation, and an item the
  learner declines MUST stay unmemorized and be offered again in a later session.
* **FR-008**: A heading's passage card MUST come with the first of its verses in the session, and a
  chapter's club-list card with the last of its verses in the session, by session order.
* **FR-009**: The session MUST end on a summary of what was memorized.
* **FR-010**: The drill's per-verse build-up (FR-004) MUST be the memorize flow's progression. A
  separately documented progression that differs from it MUST be retired.
* **FR-011**: A design document MUST own the memorize session flow, and `docs/session.md` MUST NOT
  describe a memorize flow the app does not run.
* **FR-012**: Each contributing year MUST carry at most its own batch size of orphans in total, MUST
  place them after its year's verses, and MUST offer those not included in a later session. Orphans
  MUST come only from verses already memorized.

### Key Entities

* **Session item**: something the learner reads and graduates: a verse with all its new cards, or an
  extra card on its own.
* **Heading and chapter-list card**: a heading's passage card or a chapter's club-list card, riding
  along with the session's verses or as a catch-up for verses memorized earlier.
* **Orphan**: an optional card (first words, which heading, which club) still new on a verse
  memorized earlier.
* **Drill**: the cards left to drill from the session's remaining items, less any which-book card
  the drill skips, and which of each verse's blanks have been shown.

## Success Criteria _(mandatory)_

### Measurable Outcomes

* **SC-001**: No year's part of a session carries more than its batch size of heading and
  chapter-list cards, or more than its batch size of orphans.
* **SC-002**: Every heading, chapter-list and orphan card outstanding is offered within a bounded
  number of sessions, so none is starved by the caps.
* **SC-003**: In 100% of drills, every verse's blanks are first shown in phrase order and its
  whole-verse cards come only after all of its blanks are answered Good.
* **SC-006**: In 100% of drills, no two consecutive cards belong to the same verse while another
  verse's card or an extra remains.
* **SC-004**: A learner who marks "Not yet" sees the item again in a later session in 100% of cases.
* **SC-005**: The owning doc and the app agree on every behaviour listed in this spec.

## Assumptions

* The memorize queue (which verses, and in what order) is owned by `docs/memorize.md` and is out of
  scope here.
* The drill stays unrecorded and is practice: memory tracking starts at graduation, as today.
* "Whole-verse card" means the recitation and the first-words card; the citation, reference and
  which-club or which-heading cards are short and unconstrained.
* The lesson batch size setting and its default are out of scope.

## Out of Scope

* Which verses the queue serves, and the memorize count.
* Recording drill answers as reviews.
* How graduated cards start in Review. Today every card of a verse just memorized is due
  immediately, as if last seen a year ago; starting them as "just seen" changes the memory model and
  is to be discussed separately.
* The review queue and its scheduling.
* The card faces and the typed-answer feedback (`specs/004-proofread-recitation-diff`).
