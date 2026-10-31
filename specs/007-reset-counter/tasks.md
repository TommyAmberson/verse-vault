---
description: "Task list for the reset counter"
---

# Tasks: Reset Counter

**Input**: Design documents from `/specs/007-reset-counter/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/server-api.md

**Tests**: Follow the constitution's testing principle. Where it calls for a test, the
implementation task names the test task or existing test that covers it.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing
of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

<!--
  ============================================================================
  TASK WRITING RULES (project override; constitution principle VII)

  These rules and the constitution override the speckit-tasks skill's
  defaults: tests are not optional where the testing principle calls for
  them, and stories are not ordered Models -> Services -> Endpoints.
  Keep this comment in the generated tasks.md, so commands that add tasks
  later (/speckit-converge) see the same rules.

  - Describe the behaviour, and the test that proves it where the testing
    principle calls for one, not the code. Name a function, signature, option,
    or literal only when the task changes an existing one or the spec,
    data-model.md, or contracts/ already fixes it. Let implementation choose new names; naming the file a change
    lands in is fine.
  - Every decision or write path the feature adds has one owner, named in
    plan.md's "Reuse and Ownership" table. A task that touches it points at that
    owner; never split one rule's implementation across several tasks or files.
  - Reuse first. A task that adds a helper, module, type, or test fixture names
    the existing code it checked and why that doesn't fit. Test tasks extend
    existing fixtures and stubs rather than copying them.
  - No speculative surface: every new production export has a caller the
    constitution accepts, and no task adds an option, reason code, or counter
    that only a test reads.
  - Don't specify framework or library defaults; plan.md records what the
    platform already provides.
  - Name the packages a release bumps and the semver level of each, never the
    resulting version number. The number is set when the bump commit is
    written, from master at that time, and a hotfix landing first takes it.
  - Prefer one task per coherent change over one task per layer (model, then
    service, then endpoint). Split only where tasks can genuinely run or be
    reviewed apart.
  ============================================================================
-->

## Phase 1: Setup

No setup: the feature lives in the existing `packages/api` and `apps/web`.

---

## Phase 2: Foundational (Blocking Prerequisites)

- [X] T001 Add the reset-counter table to `packages/api/src/db/schema.ts` per data-model.md
  (`userId` primary key referencing `user.id`, cascade on delete; `counter` "not null, starts at 0
  (no row reads as 0), only increases") and generate its migration into `packages/api/migrations/`
  with `pnpm db:generate`. Add the counter owner in a new module under `packages/api/src/lib/`
  (plan.md "Reuse and Ownership": read, compare, increment). No existing lib module holds per-account
  state outside Better Auth's tables, so a new one is the owner. Unit tests in a sibling test file:
  no row reads 0, increment is monotonic.
- [ ] T002 Make every response to an authenticated `/api/*` request carry the current counter header
  (contracts/server-api.md "Response"), as one middleware registered next to the existing
  `/api/*` middleware in `packages/api/src/app.ts`, reading through T001's owner. Test in
  `packages/api/src/routes/account.test.ts` that a signed-in request gets the header and an
  anonymous one doesn't.

**Checkpoint**: the counter exists, and clients can read it.

---

## Phase 3: User Story 1 - A wipe stays wiped (Priority: P1) 🎯 MVP

**Goal**: progress written against an older counter is refused and stores nothing.

**Independent Test**: wipe an account, then send a review upload with the old counter; it is refused
with 409 and nothing is held; enrolling the deck again shows no progress.

- [ ] T003 [US1] Move the counter on at the start of `wipeAccount` in
  `packages/api/src/lib/reset.ts`, before the per-deck passes (research.md D4), and return it with
  the summary so `DELETE /api/account/progress` and `DELETE /api/account/data` in
  `packages/api/src/routes/account.ts` include `resetEpoch` in their bodies (contracts "Wipes").
  Extend `packages/api/src/lib/reset.test.ts`: both wipes increment it once, and the existing race
  test's queued writes see the new value.
- [ ] T004 [US1] Refuse a stale counter on the progress routes (contracts "Progress writes"):
  `POST /api/sync/:materialId/events` in `packages/api/src/routes/sync.ts`, and `POST /review`,
  `/memorize/graduate`, `/memorize/graduate-card` in `packages/api/src/routes/cards.ts`. Each checks
  through T001's owner at the top of the handler, before any `takeNotApplied`, and again inside
  `withLock` before writing; a mismatch returns `409` with
  `{ "error", "code": "reset", "resetEpoch" }` and stores nothing. An absent header is accepted (D6)
  with a TODO at the comparison pointing to the removal issue (T010). Tests in
  `packages/api/src/routes/sync.test.ts` and a cards route test: stale counter refused with nothing
  stored or held; current counter accepted; absent header accepted; a review queued on the deck's
  lock behind a wipe is refused. Extend the import tests in `packages/api/src/routes/account.test.ts`:
  an import sent with a stale counter succeeds (FR-009).

**Checkpoint**: the server can no longer be brought back to pre-wipe progress by a client that sends
its counter.

---

## Phase 4: User Story 2 - A device that missed a wipe catches up (Priority: P2)

**Goal**: a device that learns of a newer counter clears that account's local data and shows one
notice, unless it ran the wipe.

**Independent Test**: with a stored counter of 0, a response carrying 1 clears the profile's local
data, stores 1, and raises the notice once; a profile with no stored counter adopts 1 silently.

- [ ] T005 [US2] Keep the last-seen counter on the profile row (`resetEpoch` per data-model.md:
  "absent until the first response that carries a counter; then the highest value seen") and have
  `request()` in `apps/web/src/api.ts` send it on every call and read the response header back,
  reusing its existing header handling. A newer value, or a `409` with `code: "reset"`, triggers
  catch-up in `apps/web/src/composables/useAuth.ts`: `resetProfileLocalData`, store the counter, mark
  the notice pending; absent → n adopts without clearing. A refused request is not retried. Tests
  beside the existing `api.ts` / `useAuth.ts` tests for each data-model.md transition.
- [ ] T006 [US2] Mark a wipe as in progress for the profile before `confirmWipe` in
  `apps/web/src/views/SettingsAccountView.vue` sends it, and clear the mark after its local reset;
  T005's catch-up adopts a newer counter without the notice while the mark is set (D5), so neither
  the wipe response's header nor a late refusal of this device's own upload shows it. Test in
  T005's test file.
- [ ] T007 [US2] After catch-up, send a running review or memorize session back to Home and show the
  one-time "reset on another device" notice in the app shell (`apps/web/src/App.vue`), so it shows
  whatever view the learner is in; cleared once seen; plain text, no download option. Reuse an
  existing app-level banner if one exists rather than adding a component.

**Checkpoint**: two-browser walkthrough in quickstart.md steps 1-6 passes.

---

## Phase 5: User Story 3 - Older clients keep working for one release (Priority: P3)

- [ ] T008 [US3] Confirm, with the absent-header tests from T004, that requests without a counter
  are handled as before; no code beyond T004's allowance.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T009 [P] Document the counter header, the refusal, and the wipe response in
  `docs/server-api.md`, the notice in `docs/web-nav.md`, and point spec 006's "Another device still
  signed in after a wipe" edge case in `specs/006-email-verification-reset/spec.md` to this feature
  (FR-010). Prose says "reset counter"; `resetEpoch` names it only on the wire and in storage.
- [ ] T010 [P] File a GitHub issue to refuse requests without a counter in the next api release
  (FR-008), labelled `claude-created`; reference it from T004's TODO.
- [ ] T011 Release api MINOR and web MINOR with changelog entries
  (`packages/api/CHANGELOG.md`, `apps/web/CHANGELOG.md`); core and wasm unchanged.
- [ ] T012 Run quickstart.md: automated checks including `vite build`, then the browser walkthrough
  (user-side).

---

## Dependencies & Execution Order

- T001 → T002 → US1 (T003, T004) → US2 (T005 → T006, T007) → US3 (T008) → Polish.
- US2 needs the response header (T002) and the 409 shape (T004).
- T009 and T010 can run alongside any story once T004's shapes are fixed.

## Parallel Example

```text
After T004: T009 (docs) and T010 (issue) in parallel with T005.
```

## Implementation Strategy

MVP is US1: once T001-T004 ship, a current web client can no longer resurrect pre-wipe progress,
even before it learns to catch up. US2 removes the refusal loop and adds the notice; US3 is
verification only.
