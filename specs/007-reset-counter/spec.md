# Feature Specification: Reset Counter

**Feature Branch**: `feat/reset-epoch`

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "Per-account reset counter, so work from before Delete all progress or
Reset account can't bring old progress back" (follow-up to spec 006, phase 2c)

## Context

Delete all progress and Reset account (spec 006, User Story 5) clear an account's progress on the
server and on the device that ran them. Work made before the wipe can still reach the server
afterwards:

* another device still signed in keeps its cached progress and unsent reviews, and uploads them on
  its next sync;
* the device that ran the wipe can have an upload already under way while the wipe runs;
* a review that read its deck before the wipe can write after it.

The server keeps reviews for a deck that is not enrolled, and applies them when the deck is enrolled
again, so pre-wipe progress comes back on an account the learner was told is new. Spec 006 records
this as the known limitation "Another device still signed in after a wipe". This feature closes it.

The design was agreed when that limitation was accepted: the account carries a reset counter that
every wipe moves on, and progress written against an older counter is refused.

## Clarifications

### Session 2026-10-30

* Q: Should importing a backup also move the reset counter on, as a wipe does? → A: Only if needed;
  it isn't. Import merges (events already present are skipped, newer settings win) and never
  replaces progress, so other devices' cached progress and unsent reviews stay valid. Import neither
  checks nor moves the counter.
* Q: Should settings changes and enrolment from a device that missed a wipe be refused too? → A: No.
  They carry no progress, and the device catches up at its next launch or sync; a deck re-enrolled
  this way starts new, possibly with its old settings.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - A wipe stays wiped (Priority: P1)

A learner runs Delete all progress or Reset account on one device. A phone still signed in to the
same account has reviews it hasn't uploaded yet. When the phone next syncs, those reviews are
refused, and the account stays as the wipe left it, including after the learner enrols the deck
again.

**Why this priority**: it is the whole point of the feature; without it a wipe can quietly undo
itself.

**Independent Test**: wipe an account from one browser while a second browser holds unsent reviews
for it; sync the second browser, then enrol the deck again from either; the deck shows no progress.

**Acceptance Scenarios**:

1. **Given** a device holding progress from before a wipe, **When** it uploads that progress,
   **Then** the server refuses all of it and stores none of it, held or applied.
2. **Given** a review that read its deck before a wipe, **When** it tries to write after the wipe,
   **Then** the write is refused.
3. **Given** the device that ran the wipe had an upload under way, **When** that upload arrives
   after the wipe, **Then** it is refused and the wipe's result stands.
4. **Given** a device that has caught up with the wipe, **When** it records and uploads new reviews,
   **Then** they are accepted as normal.

---

### User Story 2 - A device that missed a wipe catches up (Priority: P2)

When a device learns that its account was wiped elsewhere, at launch, at its next sync, or because a
write was refused, it clears its local copy of that account's progress and shows a plain notice
saying the account was reset from another device. The learner then carries on from the new state.

**Why this priority**: refusal alone would leave the device showing old progress and retrying
forever; it has to catch up for the learner to keep using it.

**Independent Test**: wipe an account from one browser, then open the app in a second browser that
was signed in before the wipe; the notice shows once and the decks show the wiped state.

**Acceptance Scenarios**:

1. **Given** a device signed in before a wipe elsewhere, **When** the app launches or syncs,
   **Then** it clears its local progress for that account, shows the notice once, and shows the
   account's state as the server has it.
2. **Given** a device whose write was refused as pre-wipe, **When** the refusal arrives, **Then**
   the device does the same as in scenario 1 instead of retrying the write.
3. **Given** the device that ran the wipe, **When** its own late upload is refused, **Then** it
   shows no notice, since the learner already knows.
4. **Given** a device signed in to several accounts (profiles), **When** one account was wiped,
   **Then** only that account's local data is cleared.

---

### User Story 3 - Older clients keep working for one release (Priority: P3)

A device running a client from before this feature sends no reset counter. For one release the
server still accepts its writes, so learners aren't cut off before their client updates. The release
after that refuses them.

**Why this priority**: it keeps an update from breaking sync for anyone, but only matters for the
release window.

**Independent Test**: send a review upload without a counter; it is accepted in this release, and
refused once the allowance is removed.

**Acceptance Scenarios**:

1. **Given** this release, **When** a write arrives without a counter, **Then** it is handled as
   before this feature.
2. **Given** the following release, **When** a write arrives without a counter, **Then** it is
   refused in a way an older client treats as a failed upload, not as data loss.

### Edge Cases

* **Offline reviews across a wipe.** Reviews recorded offline on a device that missed a wipe are
  lost when it catches up. This is accepted: the wipe dialog offers a backup, and a learner who
  wiped meant to start over. No "download unsent reviews" option is offered.
* **Two wipes in a row.** A device that missed both catches up once, to the latest state; it needs
  no record of the wipe in between.
* **Wipe while a device is mid-session.** The session's next write is refused and the device catches
  up; the session ends rather than continuing on progress that no longer exists.
* **Restoring a backup.** Import is exempt: it neither needs the current counter nor moves it. It
  merges into the account rather than replacing it, so other devices' data stays valid. A backup
  taken before a wipe can be imported after it to undo the wipe.
* **Settings and enrolment.** Changing per-year settings or enrolling a deck is not checked against
  the counter: neither carries progress, and a deck enrolled from a stale device starts new,
  possibly with the settings that device sent.
* **A new account or one never wiped.** Starts with the first counter value; clients that have never
  seen a counter adopt it at sign-in without clearing anything.
* **A device that first hears of the counter after a wipe (accepted for this release).** A device
  moving up from a client older than this feature adopts the counter it first sees without clearing,
  since it can't tell its pre-wipe work from work made after the wipe, and older clients' writes are
  accepted without a counter anyway (FR-008). The release that refuses requests without a counter
  closes this too.
* **Several tabs or profiles on one device.** Only a response for the account the app is showing
  counts, and a tab that finds the counter already stored by another tab doesn't clear again.

## Requirements _(mandatory)_

### Functional Requirements

* **FR-001**: Every account MUST have a reset counter. Delete all progress and Reset account MUST
  each move it on, as part of the wipe, so no write can be accepted against the old value once the
  wipe has started clearing progress.
* **FR-002**: Every client write that carries progress (review uploads through sync, answers to a
  sync merge question, single review submissions, and memorize graduations) MUST carry the counter
  the client last saw for that account.
* **FR-003**: The server MUST refuse a progress write whose counter is not the account's current
  one, storing none of it, applied or held. The check MUST be made at the moment of writing, after
  any wait for the deck, so a write that read its deck before a wipe is refused too.
* **FR-004**: A refusal for a stale counter MUST be distinguishable by clients from other failures,
  and MUST carry the current counter.
* **FR-005**: Clients MUST learn the current counter at sign-in, at launch, and with each sync, and
  the wipe itself MUST return the new counter to the device that ran it.
* **FR-006**: When a client learns of a counter newer than its own, it MUST clear its local
  progress, cached decks, and unsent writes for that account only, adopt the new counter, and reload
  the account's state from the server.
* **FR-007**: After catching up from a wipe made elsewhere, the client MUST show one plain notice
  that the account was reset on another device. It MUST NOT show it when the wipe was made on the
  same device.
* **FR-008**: For one release, a write without a counter MUST be handled as it was before this
  feature. The following release MUST refuse such writes; that change MUST be tracked so it isn't
  forgotten.
* **FR-009**: Import MUST NOT require or move the counter.
* **FR-010**: The spec 006 edge case "Another device still signed in after a wipe" MUST be updated
  to point to this feature once it ships.

### Key Entities

* **Reset counter**: one value per account, starting at the first value for a new account and moved
  on by each wipe. Clients keep the last value they saw per account.

## Success Criteria _(mandatory)_

### Measurable Outcomes

* **SC-001**: After a wipe, no review or graduation made before it appears on the account, whether
  it arrives from another device, a late upload from the same device, or a review that read its deck
  before the wipe, including after the deck is enrolled again.
* **SC-002**: A device that missed a wipe shows the wiped state, with one notice, at its next launch
  or sync, with no action from the learner.
* **SC-003**: Learners on a client from before this feature see no change in sync behaviour during
  the release window.
* **SC-004**: Reviews made after a device has caught up are never refused for a stale counter.

## Assumptions

* A wipe is rare, so clearing a device's local data for the account is an acceptable cost, and the
  wipe dialog's backup is the safety net for unsent reviews.
* Every progress write already names its account, so a single per-account value is enough; a
  per-deck counter is not needed.
* "One release" is the next released version of the API after the one that ships this feature.
* Out of scope: an email code or recent sign-in before a wipe, and downloading unsent reviews (both
  declined in spec 006).
