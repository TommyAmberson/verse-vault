---
description: "Task list for 002-resilient-sync-ingest"
---

# Tasks: The Server Takes Every Event

**Input**: Design documents from `/specs/002-resilient-sync-ingest/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/sync-events.md](./contracts/sync-events.md)

**Tests**: Included. Constitution principle IV prefers tests before the feature, and the client
behaviour this feature changes has no coverage today (#157).

**Organization**: Grouped by user story. Note the deviation from strict priority order below.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US0, US1, US2, US3, US4 from spec.md

## Ordering deviation, stated up front

US0 ("an online device can be wiped without loss") is P0 but ships after US1, because it is an
end-to-end outcome rather than a layer: it needs US1's server half underneath it. Phases here run in
dependency order and carry their real priority labels. US1 is the MVP that makes the bug
survivable; US0 is what makes it correct, and it now includes moving the stale-merge question to
the server (FR-011, research D6).

---

## Phase 1: Setup

**Purpose**: The test harness this feature's client work cannot be verified without.

- [X] T001 Add `fake-indexeddb` as a dev dependency to `apps/web/package.json` and register it in
      `apps/web/vitest.config.ts` so IndexedDB-backed modules are testable (closes #157)
- [X] T002 Create `apps/web/src/lib/engine/testing/harness.ts` providing a stubbed `WasmEngine`
      (`has_card`, `graduate_card`, `replay_event`) and a seeded IndexedDB, so `engineStore` tests
      need no real wasm build

**Checkpoint**: `pnpm --filter @verse-vault/web test` runs a trivial test that opens IndexedDB.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T003 Write a failing test in `packages/api/src/lib/engine.test.ts`: a material whose
      `review_events` contains one row with a card id the engine does not know still rebuilds, and
      the skip is logged
- [X] T004 Make replay total in `packages/api/src/lib/engine.ts` `rebuildFromEvents`: wrap
      `engine.replay_event` per event, skip and count failures, emit one structured log line naming
      the material and the skipped ids (closes #152)
- [X] T005 Write a failing test in the `crates/core/src/builder.rs` test module: for every
      combination of `heading_card`, `heading_passage_card`, `ftv`, `club_card_scope` and
      `chapter_list_scope` over a fixture deck, the card ids `build_with_config` emits are a subset
      of those emitted under `MaterialConfig::max_emission()` (research D8)
- [X] T006 Add `MaterialConfig::max_emission()` to `crates/core/src/material_config.rs`: default
      config with `heading_card: true`, `heading_passage_card: true`, `ftv: true`,
      `club_card_scope: TierScope::All`, `chapter_list_scope: ChapterListScope::Up300`, and every
      club's memorize and review enabled (a paused club drops its cards), with a
      docstring naming the T005 test as its guard. Bump `crates/core/Cargo.toml` to 0.10.0 and add a
      dated `## [0.10.0]` entry to `crates/core/CHANGELOG.md` in the same commit
- [X] T007 Export `max_emission_config_json()` from `crates/wasm/src/lib.rs` as a free
      `#[wasm_bindgen]` function returning the config's JSON; bump `crates/wasm/Cargo.toml` to 0.10.0
      with a dated `crates/wasm/CHANGELOG.md` entry; rebuild `pkg/` and extend
      `crates/wasm/test-smoke.js` to construct an engine from it
- [X] T008 Write failing tests in `packages/api/src/lib/engine.test.ts` for `classifyCardId`: an id
      the current config emits is `emitted`; an id only the max-emission engine has is
      `not-emitted`; an id neither has is `unknown`; and the max-emission engine is built once per
      material content, shared across learners
- [X] T009 Implement `classifyCardId` in `packages/api/src/lib/engine.ts`: check the loaded engine's
      `has_card` first, and only on a miss build (or reuse from a cache keyed by material and content
      sha) a `WasmEngine` from `max_emission_config_json()` and check
      there. Depends on T007
- [X] T010 [P] Write `packages/api/migrations/0028_pending_events.sql` creating `pending_events` per
      [data-model.md](./data-model.md): `id` text PK; `user_id` text NOT NULL referencing `user`
      with cascade delete; `material_id` text NOT NULL, not a foreign key; `client_event_id` text
      NULL; `kind` text NULL; `timestamp_secs` integer NULL; `payload_json` text NOT NULL; `status`
      text NOT NULL (`pending`, `unusable`, or `discarded`); `reason_code` text NOT NULL; `reason`
      text NOT NULL; `received_at` integer NOT NULL. Unique index on
      `(user_id, material_id, client_event_id)`; index on `(user_id, material_id, status)`. Each
      statement followed by `--> statement-breakpoint`
- [X] T011 [P] Add the `pendingEvents` table to `packages/api/src/db/schema.ts` mirroring T010,
      with a comment explaining why these rows are not in `review_events` (replay must never have to
      filter the log), and export the reason-code union from the contract
- [X] T012 Write failing tests in `packages/api/src/lib/pending-events.test.ts` for: taking an event
      as `pending` and as `unusable` with a reason code; re-taking the same `clientEventId` being a
      no-op; two events with `NULL` `clientEventId` both being stored; counting by
      `(user, material, status, reason_code)`; and summarising `awaiting-confirmation` rows
- [X] T013 Implement `packages/api/src/lib/pending-events.ts` with `take`, `promote`,
      `markDiscarded`, `summariseAwaitingConfirmation`, and `countForOperator`, depends on T010-T012

**Checkpoint**: Migration applies to a copy of production; helpers are green; replay tolerates a bad
row; `classifyCardId` separates a switched-off FTV card from an id no config emits;
`tools/check-contract-versions.sh` passes.

---

## Phase 3: User Story 1 - One bad event costs only itself (Priority: P1) 🎯 MVP

**Goal**: The upload applies what it can, stores the rest, and refuses no event.

**Independent Test**: POST a batch mixing good events with an unresolvable card id; the good ones
land, the response reports all of them by index, and the status is 200.

### Tests

- [X] T014 [P] [US1] In `packages/api/src/routes/sync.test.ts`, replace "rejects events carrying
      card ids the engine does not know" with a test asserting 200, the good events persisted, and
      one `dispositions` entry per event, each with its `index`
- [X] T015 [P] [US1] Add a test that a batch where nothing is applicable returns 200 with every
      event dispositioned and `review_events` untouched
- [X] T016 [P] [US1] Add a test that malformed events (bad grade, unknown kind, negative id, missing
      `clientEventId`) are taken as `unusable` with reason code `malformed`, and that the one with no
      id is reported with `clientEventId: null` at its index
- [X] T017 [P] [US1] Add a test that re-uploading an event already taken as `pending` reports
      `duplicate` and creates no second row (FR-012, research D2)
- [X] T018 [P] [US1] Replace the "not enrolled" 404 test with one asserting 200 and every event
      taken as `pending`, reason code `not-enrolled` (FR-018)

### Implementation

- [X] T019 [US1] In `packages/api/src/routes/sync.ts`, replace the `unknownCardIds` 400 with
      per-event classification through `classifyCardId`: `emitted` is applied as today;
      `not-emitted` is `pending` / `card-not-emitted`; `unknown` is `unusable` / `card-unknown`
- [X] T020 [US1] Remove the field-validation 400s from `validateUpload`, reclassifying malformed
      events as `unusable` / `malformed` with the validation message as `reason`. Keep 400 only for
      a body that is not an object with an `events` array; keep 401, 409 and 413
- [X] T021 [US1] Replace the `tryLoad` null 404 with taking every event as `pending` /
      `not-enrolled`
- [X] T022 [US1] Extend the dedup check to query `review_events` and `pending_events` together so a
      retry cannot duplicate a pending row (research D2)
- [X] T023 [US1] Add `dispositions` (`index`, `clientEventId`, `disposition`, `reasonCode`,
      `reason`) to the merged response, keeping `accepted`/`duplicates` counting only applied and
      already-known events
- [X] T024 [US1] Rewrite the api CHANGELOG entry added earlier on this branch so it describes the
      shipped behaviour rather than the 400 it replaced, and bump `packages/api/package.json`

**Checkpoint**: The original incident's batch, replayed against a test server, lands 49 of 57 events
and reports the other 8.

---

## Phase 4: User Story 0 - An online device can be wiped without loss (Priority: P0)

**Goal**: The outbox always drains, so client storage holds nothing that matters, including while a
merge question is open.

**Independent Test**: Sync, clear site data, reload, compare state. Run
[quickstart.md](./quickstart.md) §1 and §2.

### Server tests

- [X] T025 [P] [US0] In `packages/api/src/routes/sync.test.ts`, change "returns needsConfirm when
      the batch predates many server events" to assert the batch is taken as `pending` /
      `awaiting-confirmation`, the response is a normal 200 with `needsConfirm: true`,
      `staleSummary`, and one disposition per event, and `review_events` is untouched
- [X] T026 [P] [US0] Test that `GET /:materialId/state` reports `pendingConfirmation` while such
      rows exist and `null` otherwise
- [X] T027 [P] [US0] Test `POST /:materialId/confirm`: `merge` applies the rows at their recorded
      times and rebuilds; `discard` sets `status = 'discarded'` and deletes nothing; either with no
      open question is a 200 no-op; any other `decision` is 400
- [X] T028 [P] [US0] Test the old-client path: re-uploading held events with `confirmMerge: true`
      applies them and reports `applied`, not `duplicate`

### Server implementation

- [X] T029 [US0] In `packages/api/src/routes/sync.ts`, turn the stale-merge preflight into taking
      the fresh events via `pending-events.take` as `awaiting-confirmation`, returning the merged
      shape with `needsConfirm` and `staleSummary`
- [X] T030 [US0] Add `pendingConfirmation` to the `GET /:materialId/state` response from
      `summariseAwaitingConfirmation`
- [X] T031 [US0] Add `POST /:materialId/confirm`, taking the engine lock, promoting or discarding
      the `awaiting-confirmation` rows, and rebuilding on merge
- [X] T032 [US0] Treat an upload with `confirmMerge: true` whose events are held as
      `awaiting-confirmation` as a merge of those rows

### Client tests

- [X] T033 [P] [US0] In `apps/web/src/lib/engine/engineStore.test.ts` (new, uses the T002 harness):
      a `200` deletes every event the request carried, even when `dispositions` is empty or lists
      values the client does not recognise
- [X] T034 [P] [US0] Test that an outbox of 501 events drains across two requests, neither exceeding
      the 500 cap (FR-013, closes #156)
- [X] T035 [P] [US0] Test that a `needsConfirm: true` response carrying `dispositions` empties the
      outbox, while the old server's arm without `dispositions` keeps it (contracts, Compatibility)
- [X] T036 [P] [US0] In `apps/web/src/lib/engine/persistence.test.ts` (new): opening a v1 database
      holding orphan rows migrates them into `eventQueue` and drops the store (FR-014)

### Client implementation

- [X] T037 [US0] In `apps/web/src/lib/engine/engineStore.ts` `doFlush`, delete every sent event on
      any `200`, and drop the quarantine-and-retry branch entirely
- [X] T038 [US0] Chunk the upload in `doFlush` at the server's 500-event cap, looping until the
      outbox is empty (FR-013)
- [X] T039 [US0] Remove the per-material stale gate from `engineStore.ts`, keeping only the
      old-server fallback that holds the outbox when `needsConfirm` arrives without `dispositions`
- [X] T040 [US0] In `apps/web/src/composables/useEngine.ts`, drive the modal from
      `pendingConfirmation` on `GET /state`; make `confirmMerge` and `discardStale` call
      `POST .../confirm`, with discard still invalidating the session and snapshot caches afterwards
- [X] T041 [US0] Update `apps/web/src/components/StaleMergeModal.vue` copy: discarding sets the
      reviews aside on the server rather than deleting them
- [X] T042 [US0] Bump `DB_VERSION` to 2 in `apps/web/src/lib/engine/persistence.ts`; in the upgrade
      path re-enqueue any `eventQueueOrphans` rows into `eventQueue`, then delete the store
- [X] T043 [US0] Delete `moveToOrphans`, `getOrphans`, `countOrphans` from `persistence.ts`, and
      `orphanCount` from `useEngine.ts`
- [X] T044 [US0] Delete `apps/web/src/lib/engine/syncErrors.ts` and its test if nothing still reads a
      refusal body; otherwise reduce it to what remains needed
- [X] T045 [US0] Update `SyncEventsResponse` and the state response in
      `apps/web/src/lib/engine/types.ts`, add the confirm call to `apps/web/src/api.ts`, then add the
      web CHANGELOG entry and version bump

**Checkpoint**: quickstart §1, §2 and §3 pass by hand.

---

## Phase 5: User Story 2 - Changing a setting never strands past work (Priority: P2)

**Goal**: A pending event applies itself once it can, at the time it was recorded.

**Independent Test**: Queue a graduation, disable its card type, sync, re-enable, confirm applied.

### Tests

- [X] T046 [P] [US2] In `packages/api/src/lib/engine.test.ts`: building an engine with a
      `card-not-emitted` event that is now resolvable promotes it, writes the real row at its
      recorded `timestamp_secs`, and deletes the pending row
- [X] T047 [P] [US2] Test that promoting a review older than applied history rebuilds, and the
      resulting test state equals one where the review had been applied on time (FR-016)
- [X] T048 [P] [US2] Test that a still-unresolvable event stays pending and does not affect
      `stateRev`, and that `awaiting-confirmation` rows are never promoted at build (FR-007)
- [X] T049 [P] [US2] Test that `not-enrolled` rows are promoted at the first build after enrolment
      (FR-018)
- [X] T050 [P] [US2] Test that promotion is a single transaction: the pending row and the real row
      are never both present

### Implementation

- [X] T051 [US2] In `packages/api/src/lib/engine.ts`, before replay, call `pending-events.promote`
      for this `(user, material)` over `card-not-emitted` and `not-enrolled` rows only, promoting
      those whose ids the engine now emits (`has_card`), guarded by an indexed count so the common
      no-pending case costs one query (research D4)
- [X] T052 [US2] In `load`, hand off to `rebuildFromEvents` whenever promotion wrote a review, since
      `load` restores materialised test states rather than replaying

**Checkpoint**: quickstart §4 passes.

---

## Phase 6: User Story 3 - Stranded work is visible without asking the learner (Priority: P3)

**Goal**: Answerable from the server in one query.

**Independent Test**: Run the query in quickstart §6 against a database with pending rows.

- [X] T053 [P] [US3] Keep and repoint the structured log added earlier on this branch: log each
      taken-but-unapplied event's status, reason code and reason with the requestId, replacing the
      refusal log in `packages/api/src/routes/sync.ts`
- [ ] T054 [US3] Add the operator query to `docs/test-scenarios.md` (or a short runbook note) so the
      two-week diagnosis has a documented one-liner

**Checkpoint**: quickstart §6 returns rows.

---

## Phase 7: User Story 4 - A shipped repair recovers stranded work (Priority: P4)

**Goal**: Unusable events stay retryable; a shipped repair applies the moment it can (FR-019).

**Independent Test**: Store an unusable event, register a repair that fixes it, load the engine,
confirm it applied at its recorded time and the row records the repair.

### Tests

- [ ] T055 [P] [US4] In `packages/api/src/lib/engine.test.ts`: a repair that fixes a malformed
      review makes it apply at its recorded time on the next build, and the row is kept as
      `status = 'repaired'` with `original_payload_json` and `repaired_by` set
- [ ] T056 [P] [US4] Test that a repair whose output still cannot apply (malformed, or a card no
      config emits) leaves the row unchanged, records `repair_epoch`, and is not re-run on the next
      build; shipping another repair retries the row once
- [ ] T057 [P] [US4] Test that `discarded` rows are never repaired, and that a repair changing an
      event's non-null `clientEventId` is rejected

### Implementation

- [ ] T058 [US4] Move upload parsing (`parseUpload`, `SyncEventUpload`, `eventKind`) from
      `packages/api/src/routes/sync.ts` to `packages/api/src/lib/sync-events.ts`, so a repair's
      output is validated exactly as an upload is
- [ ] T059 [US4] Add `original_payload_json` text NULL, `repaired_by` text NULL and `repair_epoch`
      text NULL to `pending_events` in `packages/api/migrations/0029_pending_event_repairs.sql` and
      `packages/api/src/db/schema.ts`; `status` gains `repaired`, and reason codes gain `repaired`
- [ ] T060 [US4] Create `packages/api/src/lib/repairs.ts`: the `Repair` interface, the shipped
      `REPAIRS` registry (empty until the first repair ships), and the epoch fingerprint
- [ ] T061 [US4] In `packages/api/src/lib/engine.ts`, try repairs on the key's unusable rows before
      promotion, classify each output through `classifyCardIds`, and keep promoted repaired rows as
      `repaired`; make promotion's review insert tolerate an already-applied id so a bad row can
      never fail a build
- [ ] T062 [US4] Document repairs in `docs/persistence.md` and how to write one in the header of
      `packages/api/src/lib/repairs.ts`

**Checkpoint**: an empty registry changes nothing; a test registry recovers a malformed event.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T063 [P] Rewrite the sync section of `docs/server-api.md` from
      [contracts/sync-events.md](./contracts/sync-events.md), including the new confirm route and
      `pendingConfirmation`, removing the deviation note added earlier on this branch (FR-015)
- [ ] T064 [P] Add `pending_events` to the storage model in `docs/persistence.md`, stating that
      replay reads `review_events` only
- [ ] T065 Close #151, #153, #155, #156, #157, #158 against this branch, and #152 with T004
- [ ] T066 Run the whole of [quickstart.md](./quickstart.md), including both wipe tests on a real
      browser profile
- [ ] T067 Decide whether an `unusable` or `discarded` row is terminal: unusable rows are retryable
      by shipped repairs, discarded rows stay the learner's decision (research D9, US4)

---

## Dependencies & Execution Order

- **Setup (T001-T002)**: no dependencies
- **Foundational (T003-T013)**: needs nothing from Setup, but blocks every story. T005-T007 are
  sequential (test, core, wasm); T008-T009 follow T007. T010-T011 are [P] with each other and with
  the crate work; T012-T013 follow them
- **US1 (T014-T024)**: needs Foundational. This is the MVP
- **US0 (T025-T045)**: needs US1's server half. Server tasks T025-T032 need no client work; client
  tests T033-T036 need Setup's harness. T039-T041 need T030-T031 deployed or stubbed
- **US2 (T046-T052)**: needs Foundational; independent of US0's client work. T031's merge reuses
  T051's promotion, so whichever lands second calls the other
- **US3 (T053-T054)**: needs US1
- **US4 (T055-T062)**: needs US2's promotion, which a repaired event goes through
- **Polish (T063-T067)**: needs everything it documents

### Parallel opportunities

- T003-T004 (replay), T005-T007 (crates) and T010-T011 (migration) as three parallel tracks
- All five US1 tests (T014-T018) together
- The four US0 server tests (T025-T028) together, and the four client tests (T033-T036) together
- All five US2 tests (T046-T050) together
- T063 and T064 together

---

## Implementation Strategy

**MVP**: Setup, Foundational, US1. At that point the server refuses no event, the incident cannot
recur, and an old client keeps working because the response is additive. Shippable on its own.

**Then US0**, which is where the guarantee actually lands: the client stops holding anything that
matters, and the merge question stops living in the browser. The server half (T025-T032) is safe to
ship before the client half, since an old client handles the new stale response as it does today.

**US2 and US3** are independent of each other and can follow in either order.

## Notes

- Commit per task or per logical group, per constitution principle V
- Verify each test fails before implementing against it
- Nothing deletes an `unusable`, `discarded` or `repaired` row; repairs change them in place
