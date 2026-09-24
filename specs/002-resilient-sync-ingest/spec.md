# Feature Specification: The Server Takes Every Event

**Feature Branch**: `fix/sync-takes-every-event`

**Created**: 2026-09-23

**Status**: Approved 2026-09-24

**Input**: Issues [#151](https://github.com/TommyAmberson/verse-vault/issues/151),
[#152](https://github.com/TommyAmberson/verse-vault/issues/152),
[#153](https://github.com/TommyAmberson/verse-vault/issues/153) and
[#158](https://github.com/TommyAmberson/verse-vault/issues/158), combined. Driven by constitution
principle VI, "No Client Can Get Stuck".

## Why This Exists

On 2026-09-09 a card-id migration translated the ids held on the server. Eight events sat in one
browser's outbox carrying ids from the retired space. From that moment the server refused every
upload that browser attempted, because a batch was accepted whole or not at all, and the 49 good
reviews queued behind those eight were refused with them. The learner saw reviews that would not
save; refreshing re-served the same verses. It ran for two weeks, on one browser, while the same
account synced normally in another. Nothing in any log said why: the reason existed only in a
response body nobody keeps.

The lesson is not "translate ids better". It is that a client had durable work the server would not
take, which makes that work unbacked, invisible, and one cleared cache from gone. The rule this
feature implements is simpler than the bug that prompted it:

> The server takes everything a client offers. Every time.

"Takes" does not mean "applies". An event the server cannot apply is stored anyway, on the server,
where it is backed up and countable. What the server must never do is leave a learner's work
stranded on a device.

## User Scenarios & Testing _(mandatory)_

### User Story 0 - An online device can be wiped without loss (Priority: P0)

A learner who is online can clear their browser storage, switch browsers, or reinstall, and lose
nothing.

**Why this priority**: It is the entire requirement in one sentence, and it is checkable in a minute
without reading any code. Every other story here is a way of failing it. Today it fails outright:
one browser holds 49 reviews the server will not take, so clearing it destroys them, and the support
advice has to be "do not clear your storage".

**Independent Test**: On a device with a working connection, wait for sync to settle, clear all site
storage, reload, and compare the learner's state against what it was.

**Acceptance Scenarios**:

1. **Given** an online device that has finished syncing, **When** its storage is wiped, **Then**
   reloading restores the same review history, memorised verses, and due queue.
2. **Given** an online device holding events the server cannot apply, **When** sync settles,
   **Then** those events are on the server and the device's outbox is empty.
3. **Given** a device that has been offline for a week, **When** it comes back online and sync
   settles, **Then** its outbox reaches empty, whatever it accumulated while away.
4. **Given** a device holding an event that is malformed by any measure, **When** sync settles,
   **Then** its outbox still reaches empty.
5. **Given** a device whose queued work predates a lot of newer history, so the learner must confirm
   before it merges, **When** it uploads, **Then** the work is on the server awaiting that decision
   and the outbox is empty, so wiping the device before deciding loses nothing.

---

### User Story 1 - One bad event costs only itself (Priority: P1)

A learner reviews on a device holding one event the server cannot apply. Everything else they did
lands.

**Why this priority**: This is what actually broke. One unusable event cost a learner a fortnight of
work, because acceptance was all-or-nothing. Until each event is judged on its own, every future
cause of an unusable event reproduces the same outage.

**Independent Test**: Upload a batch mixing one unusable event with several good ones, and confirm
the good ones took effect.

**Acceptance Scenarios**:

1. **Given** an outbox holding 49 applicable events and 8 that cannot be applied, **When** the
   client uploads, **Then** all 49 take effect and all 57 leave the outbox.
2. **Given** a batch where nothing can be applied, **When** the client uploads, **Then** the upload
   succeeds, the learner's state is unchanged, and the outbox still empties.
3. **Given** any upload, **When** it completes, **Then** the client is told, per event, what became
   of it.
4. **Given** an event that was already uploaded, **When** it is uploaded again, **Then** it takes
   effect once and is reported as already known rather than as a problem.

---

### User Story 2 - Changing a setting never strands past work (Priority: P2)

A learner turns a card type or a club off while unsent work sits on the device. The work uploads
regardless. Turning the setting back on brings back what was recorded against it.

**Why this priority**: The recurring cause, as opposed to the one-off migration. A card the current
settings do not produce cannot be found, so any learner who changes a setting between reviewing and
syncing can reach the same dead end, and changing settings is routine.

**Independent Test**: Queue a graduation, disable the card type it belongs to, sync, then re-enable
the type.

**Acceptance Scenarios**:

1. **Given** queued work for a card type the learner has since disabled, **When** the client
   uploads, **Then** the server stores it and the outbox empties.
2. **Given** work stored while its card type was disabled, **When** the learner re-enables that
   type, **Then** it takes effect, and a graduated card does not reappear as new work.
3. **Given** work stored for a card type that stays disabled, **When** the learner's state is built,
   **Then** the build succeeds and the stored work changes nothing.
4. **Given** a learner who never re-enables that type, **When** any amount of time passes, **Then**
   nothing degrades and nothing is lost.

---

### User Story 3 - Stranded work is visible without asking the learner (Priority: P3)

When the server stores work it cannot apply, that fact is visible to whoever maintains the system,
and to the learner if it affects what they see.

**Why this priority**: Correctness first, visibility second. But the original incident was invisible
from both ends for two weeks, and diagnosing it required reading a response body out of a browser's
developer tools. A system that cannot see its own stranded work will hide the next one just as long.

**Independent Test**: Cause work to be stored unapplied, then find it from the server alone.

**Acceptance Scenarios**:

1. **Given** work stored unapplied for any account, **When** an operator looks at the server,
   **Then** they can see how much, for whom, and why, without touching a device.
2. **Given** an event the server could not apply, **When** it is stored, **Then** the reason is
   recorded with it.
3. **Given** no such work exists, **When** an operator looks, **Then** they see that plainly rather
   than having to infer it.

---

### User Story 4 - A shipped repair recovers stranded work (Priority: P4)

When a fix for a class of unusable events ships, such as a translation for retired identifiers, the
events already stored as unusable are reconsidered under it, and the ones it makes applicable take
effect without the learner doing anything.

**Why this priority**: Storing unusable events only pays off if they can come back. The original
incident's eight events are exactly this class: unusable today, recoverable the day someone writes
the translation. Without a way to apply that fix to stored events, "stored" would mean "kept for the
record" and nothing more.

**Independent Test**: Store an unusable event, ship a repair that fixes it, and confirm the event
takes effect at the time it was recorded on the learner's next visit.

**Acceptance Scenarios**:

1. **Given** unusable events a newly shipped repair can fix, **When** the learner's state is next
   built, **Then** those events take effect at the times they were recorded.
2. **Given** an unusable event a repair cannot make applicable, **When** the repair is tried,
   **Then** the event stays unusable and unchanged, and that repair is not tried on it again.
3. **Given** an event a repair changed, **When** an operator looks, **Then** they can see the event
   as it was uploaded and which repair changed it.
4. **Given** events the learner chose to discard, **When** any repair ships, **Then** they are not
   touched: discarding was the learner's decision, not a defect.

---

### Edge Cases

* Every event in an upload is unusable: the upload still succeeds, and the outbox still empties.
* An event is uploaded twice because a retry raced a response: it takes effect once.
* An event cannot be applied now but can later, after a setting changes: it must take effect then,
  without the learner doing anything.
* An event cannot be applied by any configuration, because the verse it names is not in the deck at
  all: it is still taken and stored as unusable, and applies only if a later repair makes it
  applicable.
* A malformed event, whose shape the server cannot even interpret: it is still taken, so the outbox
  can empty, and it is stored as unusable rather than applied.
* Stored work accumulates over years for an account that keeps a card type disabled: it stays inert
  and costs nothing but space.
* A device that has been offline long enough to exceed any single upload's size limit: it still
  reaches an empty outbox, across as many uploads as that takes.
* An upload whose work predates a lot of newer history: the learner is still asked before it merges,
  but the question is asked about work already on the server, not work held on the device. Choosing
  to discard is a decision about that server-side copy, and the copy is kept, marked discarded.
* A pending event becomes applicable weeks after it was recorded: it counts at the time it was
  recorded, not at the time it applied, so the learner's schedule is what it would have been had it
  applied straight away.
* An upload for a material the account is not enrolled in: taken as pending, and applied if the
  account enrols.
* An event whose own identifier is missing or malformed, so the server cannot name it in its report:
  still taken, and the client still forgets it, because the client forgets everything an
  acknowledged upload carried.

## Requirements _(mandatory)_

### Functional Requirements

* **FR-001**: The server MUST take every event a client offers, without exception. "Take" means the
  server has accepted responsibility for it and the client may forget it.
* **FR-002**: Taking an event MUST resolve to exactly one of four dispositions: **applied**, so it
  changes the learner's state; **duplicate**, meaning the server already held it; **pending**,
  meaning it may apply later; or **unusable**, meaning nothing but a repair (FR-019) can make it
  apply. Refusal MUST NOT be a disposition.
* **FR-003**: An event MUST be judged on its own. Applicable events in an upload MUST be applied
  whatever the other events in that upload are.
* **FR-004**: An upload MUST report the disposition of every event it carried, keyed by the
  identifier the client assigned, in a form a client can act on without reading prose.
* **FR-005**: Once the server acknowledges an upload, the client MUST delete every event that upload
  carried, whatever their dispositions. The dispositions inform; they do not decide what is deleted,
  so an event the server cannot name in its report still leaves the outbox. An online client's
  outbox MUST therefore reach empty.
* **FR-006**: Pending and unusable events MUST be stored on the server with the reason they were not
  applied. They MUST NOT be stored on the client for later, under any name.
* **FR-007**: A pending event that has become applicable MUST take effect without the learner
  asking, no later than the next time the learner opens that material. The one exception is an event
  awaiting the learner's confirmation (FR-011), which waits for the answer.
* **FR-008**: A pending or unusable event MUST NOT affect the learner's state, and MUST NOT be
  counted among applied events, for as long as it has not been applied.
* **FR-009**: Building or rebuilding an account's state MUST succeed in the presence of stored
  events it cannot apply, skipping them and recording that it did so.
* **FR-010**: An operator MUST be able to see, from the server alone, how many events are pending or
  unusable, for which accounts, and why.
* **FR-011**: The existing protection against an upload that predates a large amount of server-side
  history MUST still ask the learner before merging, but MUST ask about work the server has already
  taken. Such an upload is taken as pending, awaiting confirmation, and the device's outbox empties
  as for any other upload. The learner MUST be able to answer from any device, including one wiped
  since. Choosing to discard MUST mark those events discarded on the server, not delete them, and
  not delete anything from a device.
* **FR-012**: Re-uploading an event the server has already taken MUST be harmless: it MUST NOT apply
  twice, and MUST be reported as already known.
* **FR-013**: An upload larger than the server will accept in one request MUST still drain, across
  as many requests as it takes, without the learner intervening.
* **FR-014**: Any client-side store holding events set aside from an outbox MUST be emptied by
  uploading its contents, and MUST then be removed from the client.
* **FR-015**: The authoritative contract description MUST be updated in the same change, since it
  currently documents whole-batch refusal as correct behaviour.
* **FR-016**: A pending event that takes effect MUST take effect at the time it was recorded,
  exactly as if it had applied then.
* **FR-017**: Promoting a pending event because a setting changed MUST NOT ask the learner to
  confirm a merge. Changing the setting is already the learner's decision.
* **FR-018**: An upload for a material the account is not enrolled in MUST be taken as pending, and
  MUST take effect if the account later enrols in that material.
* **FR-019**: It MUST be possible to ship a repair: a named transformation of unusable events. Each
  shipped repair MUST be tried on every stored unusable event, without the learner asking, and an
  event it makes applicable MUST then take effect as FR-007 and FR-016 describe. A repair that does
  not make an event applicable MUST leave it exactly as it was. The event as uploaded and the repair
  that changed it MUST be kept. Discarded events MUST NOT be repaired.

### What "Malformed" Means

FR-001 admits no exceptions, so the server takes structurally broken events too, and stores them as
**unusable**. This is deliberate: the alternative asks a client to decide what counts as junk, and a
client that guesses wrong strands the work. The server is the judge, and its judgement is recorded
rather than returned as a refusal.

### What Refusal Still Means

FR-001 and FR-002 are about events. A request as a whole can still be turned away, but only for a
reason that strands nothing:

* **Not signed in.** The device is not connected in the sense SC-001 means. Signing in resumes the
  upload with nothing lost.
* **Stamped against an old version of the deck.** The events are fine, only their stamp is stale.
  The client fetches current state, re-stamps, and uploads again without the learner doing anything.
* **Too many events in one request.** A page size, not a verdict. The client sends smaller pages
  (FR-013).
* **Not a list of events at all.** A body the server cannot read as a list carries nothing to take.
  No outbox content can produce one; only a broken client sends it.

Any other reason to turn a request away is a defect against FR-001.

### Key Entities

* **Event**: One recorded act of learning, being a grade or a completion. Carries an identifier the
  client assigns, which makes repeat uploads harmless.
* **Disposition**: What the server did with one event: applied, duplicate, pending, or unusable,
  with a reason when it is pending or unusable. Awaiting the learner's confirmation is one pending
  reason; not being enrolled is another.
* **Stored event**: An event the server took but did not apply. Lives on the server, carries its
  reason, is inert until applied, and is countable by an operator.
* **Repair**: A named, shipped transformation that can turn an unusable event into an applicable
  one. Tried once on each stored unusable event per set of shipped repairs.
* **Outbox**: The client's list of events not yet delivered. The only client state that is not a
  cache, and its only end state is delivered.

## Success Criteria _(mandatory)_

### Measurable Outcomes

* **SC-001**: An online device can be wiped without loss. After sync settles, clearing all of a
  device's storage and reloading leaves the learner's state unchanged.
* **SC-002**: No sequence of events, however malformed, can prevent an online device's outbox from
  reaching empty.
* **SC-003**: One unusable event costs at most itself. Every other event uploaded alongside it is
  applied.
* **SC-004**: Recovering a device that holds unusable events requires no manual steps: no console,
  no cleared storage, no support contact, no operator action.
* **SC-005**: Toggling any learning setting the app offers, with work queued, loses no work.
* **SC-006**: Building state succeeds for every account in the database today, including those
  holding records the engine cannot apply.
* **SC-007**: Stranded work is detectable from the server alone. The condition that took two weeks
  to diagnose is answerable in one query.
* **SC-008**: Every event now sitting in a client-side set-aside store reaches the server.

## Assumptions

* Storing an unusable event costs little and is worth it. These are small records, rare by
  construction, and they are both the evidence for the next migration bug and the raw material for
  the repair that fixes it.
* A pending event is reconsidered when the learner next opens the material, rather than by a
  background job. That is when a setting change takes effect anyway, and it avoids standing
  machinery for a rare case.
* Discarding stale work was already the learner's choice; this feature only moves where the
  discarded copy lives. Keeping it on the server, marked discarded, costs little and makes a
  mistaken discard recoverable by an operator.
* Work recorded against a since-disabled card type is history worth keeping, not noise. The storage
  layer already retains such rows today while the engine ignores them, so this makes existing
  behaviour deliberate.
* Existing clients that expect whole-upload acceptance keep working, and the deploy order between
  client and server does not matter, since both ship from the same commit with no ordering
  guarantee.
* The retired-id-space events from the 2026-09-09 migration are a closed set, surviving only in
  client outboxes. Once taken, the class is closed for good.
* A client-side set-aside store exists on at most one device, since the code that wrote to it was
  never released. FR-014 covers it anyway, because "probably nobody" is not a migration strategy.

## Out of Scope

* Redesigning how identifiers are derived. They are already content-derived and stable. The problem
  was never how ids are formed, it is what happens to an event the server cannot resolve.
* Writing any particular repair, including one for the eight events stranded in the original
  incident. The feature delivers the means to ship repairs; each repair is its own change.
* Any change to how grades are scheduled or how memory is modelled.
