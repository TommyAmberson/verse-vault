# Research: The Server Takes Every Event

**Date**: 2026-09-23 | **Plan**: [plan.md](./plan.md)

Nine decisions the plan depends on. Each was resolved against the existing code rather than in the
abstract, because every one of them has a precedent in the repository already.

## D1. Where pending and unusable events rest

**Decision**: A new `pending_events` table, separate from `review_events`.

**Rationale**: `review_events` is the source of truth that replay walks (`docs/persistence.md`: "the
materialised state is a cache that can be rebuilt by replay at any time"). Putting inert rows in it
means every reader must remember to filter them, and a reader that forgets applies an event that was
explicitly not applicable. Keeping the log pure means replay needs no new conditions and the
existing `stateRev` fingerprint keeps its meaning.

The table carries the whole event payload rather than a foreign key, because the point is to hold
something the engine could not resolve: there may be nothing valid to point at.

**Alternatives considered**:

* _A `status` column on `review_events`_. Rejected for the filtering hazard above, and because it
  would change the meaning of every existing count.
* _A generic dead-letter table shared with future features_. Rejected as speculative; nothing else
  needs one today, and a table with one caller should name its caller.

## D2. Keeping idempotency across two tables

**Decision**: The dedup check on upload queries `review_events` and `pending_events` together, and
`pending_events` carries the same unique constraint on `(user_id, material_id, client_event_id)`.

**Rationale**: FR-012 says re-uploading an event the server has taken is harmless. Once an event can
live in either table, a check against one of them re-takes events that are already held in the
other, which would let a retry duplicate a pending row.

**Alternatives considered**: _Move a pending event into `review_events` on promotion and rely on
that table alone_. Still needs both checked while the event is pending, so it solves nothing on its
own. Promotion does delete the pending row, which keeps the pair disjoint.

## D3. Reporting a disposition per event

**Decision**: Add `dispositions: [{ index, clientEventId, disposition, reasonCode?, reason? }]` to
the merged response. Keep `accepted` and `duplicates` as counts. The client deletes every event the
request carried on any `200`; dispositions do not drive deletion.

**Rationale**: Deleting by reported `clientEventId` fails for exactly the events this feature exists
to take: one whose id is missing or malformed cannot be named in the report, so it would never leave
the outbox. Keying the report by `index` lets the server describe it anyway, and deleting by "what I
sent" needs no report at all. It is also what the shipped client already does on a `200`, so the
rule costs an old client nothing.

`reasonCode` is a closed set a program can group and act on (promotion reads it); `reason` is prose
for operators. The first draft had only `reason`, which would have made the operator view group by
free text containing card ids, one group per id.

A list of at most `MAX_BATCH_SIZE` entries is bounded and small, so every event is reported rather
than only the exceptions.

**Alternatives considered**:

* _Report only non-applied events_. Smaller, but a client logging what happened would have to infer
  the rest.
* _Delete by reported id_. Rejected above: it strands the malformed event SC-002 names.

## D4. When a pending event is reconsidered

**Decision**: At engine build, in `EngineStore`, guarded by an indexed count so the common case of
nothing pending costs one cheap query. Only `card-not-emitted` and `not-enrolled` rows are
considered; `awaiting-confirmation` rows wait for the learner (D6). A promoted event is written at
its recorded timestamp (FR-016). A promoted review forces `rebuildFromEvents`, because `load`
restores materialised test states and would otherwise apply the review out of order; a promoted
graduation does not.

**Rationale**: The trigger that matters is a config change, and a config change already invalidates
the cached engine (`packages/api/src/lib/engine.ts`), so the next build is exactly when the world
may have changed in a way that makes a pending event applicable. No new scheduler, no background
job, no daemon to forget about.

**Alternatives considered**:

* _A hook on the settings write_. Narrower and cheaper, but misses every other reason an event might
  become applicable (a deck update, an operator repair, a future id translation).
* _A background sweep_. Standing machinery for an event class that should be rare, and one more
  thing to monitor.

## D5. What happens to the `unknownCardIds` field already on this branch

**Decision**: Keep the structured log, drop the 400. The field itself survives as the `reason` on an
`unusable` disposition rather than as the body of a refusal.

**Rationale**: The commit already on this branch (`fix(api): report which card ids sync refused`)
was written when refusal was still an outcome. Its logging half is the part that mattered, since the
original incident was undiagnosable because nothing recorded why, and that value is unchanged. Its
400 half is exactly what this feature removes.

**Consequence for the implementation**: the api CHANGELOG entry on that commit describes a 400 that
will no longer exist by the end of the branch, so it is rewritten in the same commit that removes
the refusal, not left to contradict the shipped behaviour.

## D6. Where the stale-merge question lives

**Decision**: On the server. A batch that trips the stale-merge threshold is taken as `pending` with
reason code `awaiting-confirmation`, and the response still carries `needsConfirm` and
`staleSummary` so the client can ask straight away. `GET /state` reports any open question as
`pendingConfirmation`, and a new `POST /:materialId/confirm` answers it with `merge` or `discard`.
Discard sets `status = 'discarded'`; nothing is deleted. The client-side stale gate in `engineStore`
is removed.

**Rationale**: The constitution says data waiting for a decision rests on the server. The existing
preflight took nothing until the learner answered, so while the modal was open the work existed only
in the browser, and the modal's Discard button deleted it outright. Wiping the device before
answering lost the work, which fails SC-001 for exactly the returning-after-a-gap learner the
original incident involved.

The threshold and its rationale (an old batch can drag down FSRS stability on cards reviewed since)
are unchanged. Only where the batch waits changes.

**Compatibility**: an old client re-uploading with `confirmMerge: true` after pressing Sync is
treated as `merge` for the rows it re-sends. An old client pressing Discard deletes locally and
never tells the server, leaving the server's copy awaiting an answer: inert, and answerable from any
updated client. See [contracts/sync-events.md](./contracts/sync-events.md).

**Alternatives considered**:

* _Keep the preflight and exempt it from SC-001_. Rejected: it carves the headline guarantee for the
  case most likely to need it.
* _Drop the confirmation and always merge_. Rejected: the protection is real and outside this
  feature's scope, which is where work rests, not whether the learner is asked.

## D7. Not enrolled

**Decision**: An upload for a material the account is not enrolled in is taken as `pending` with
reason code `not-enrolled`, and promoted at the first engine build after the account enrols.

**Rationale**: The route's `404` stranded those events: nothing on the client could ever make them
deliverable. No unenrol path exists today, so this is reachable only through a client bug or a
material removed server-side, which is cheap to cover and is precisely the "probably nobody" case
FR-014 already refuses to bet on. `material_id` is therefore not a foreign key.

## D8. Telling "not emitted today" from "never emittable"

**Decision**: Add `MaterialConfig::max_emission()` to `crates/core`, the config with every emission
gate at its widest: `heading_card`, `heading_passage_card` and `ftv` on, `club_card_scope: All`,
`chapter_list_scope: Up300`, and every club's memorize and review enabled, because a paused club
drops its verses' cards entirely. Export it from `crates/wasm` as JSON. When an upload carries an id
the current engine lacks, the api builds an engine for the same material with that config and checks
`has_card` there: present means `pending` / `card-not-emitted`, absent means `unusable` /
`card-unknown`. The id set is cached per material and snapshot version, so the second build happens
at most once per deck version.

**Rationale**: `has_card` answers "does the current config emit this", which is the wrong question
for a card the learner switched off. Emission in `crates/core/src/builder.rs` is gated by those five
flags and by whether each club is paused, and each gate only adds cards, so the widest setting of
each is a superset of every config. That fact is builder knowledge. Hard-coding it in the api would
reimplement engine semantics (Principle II) and go silently wrong the day a sixth flag ships: its
cards would be classified `unusable` instead of `pending`. Owning it in core, next to the builder,
lets a core test enforce the superset property so a new flag that breaks it fails `cargo test`.

The plan first listed only the five flags. Writing the core test showed that a paused club gates
emission too, which is the #153 scenario itself: pausing a club is exactly how a learner makes a
valid card vanish. An api-side list would have shipped with that hole. Pseudo-verse ids
(heading-passage and chapter-list cards) need no special case, because the builder emits them under
the maximal config like any other card.

**Alternatives considered**:

* _Decode the id in the api (`verse_id = id >> 16`) and check the verse exists_. Reimplements the id
  packing outside core, gets pseudo verses wrong, and says nothing about whether the slot or
  position is one the deck could produce.
* _A wasm `could_emit(card_id)` that rebuilds internally on every call_. Same knowledge placement,
  but a full build per unknown id instead of one cached set.
* _Treat every unknown id as `pending`_. Simple, and nothing is lost, but it makes `pending`
  meaningless for the operator view and has promotion re-check junk forever.

**Limit**: "never emittable" means under the current deck. A deck update that adds verses or
re-splits phrases can make a `card-unknown` id valid. That is the open question below, not a reason
to reclassify at every build.

## D9. Repairs

**Decision**: Unusable events stay retryable. A repair is a named function shipped in
`packages/api/src/lib/repairs.ts` that takes a stored unusable event and returns a rewritten one, or
nothing. Engine build tries the shipped repairs on the account's unusable rows for that material,
before promotion. A repair succeeds only if its output is a well-formed event whose card some config
emits; the row then becomes `pending` with reason code `repaired`, and the same build promotes it if
it applies. Each row records the set of repairs last tried on it (`repair_epoch`), so a repair is
tried once per row, and shipping a new one retries every row once. The row keeps the payload as
uploaded (`original_payload_json`) and the repair that changed it (`repaired_by`); a repaired row
that is promoted is kept as `status = 'repaired'` rather than deleted, so the record survives.
`discarded` rows are never repaired.

**Rationale**: Taking every event only helps if what was taken can come back. The case that started
this feature is one: eight events carrying retired ids are unusable today, and recoverable the day a
translation ships. Engine build is already where held events are reconsidered (D4), it has the
engine a repair's output must be checked against, and it runs for exactly the accounts that hold
rows, so no boot-time sweep or background job is needed. Requiring the output to be classifiable
keeps a bad repair from moving junk into `pending`, and recording the epoch keeps a repair that does
nothing from running on every build.

A repair may not change an event's `clientEventId` unless the event had none; one it assigns must be
unused in either table. Otherwise the repaired event could collide with an applied one.

**Alternatives considered**:

* _Terminal unusable rows, repaired by one-off scripts_. Rejected by the product owner: a fix should
  apply the moment it ships, without an operator.
* _A boot-time sweep over every unusable row_. Covers new repairs but not events uploaded after
  boot, and runs engine work for accounts that are not using the app.
* _Delete a repaired row on promotion, as for other pending rows_. Loses the record of what arrived
  and what changed it, which is the evidence the table exists to keep.
