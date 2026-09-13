---
description: "Task list for spelling-dialect implementation"
---

# Tasks: Spelling Dialects for Rendered Scripture

**Input**: Design documents from `/specs/001-spelling-dialects/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. Constitution Principle IV states tests SHOULD be written before the feature
they cover, and `CLAUDE.md` records a preference for tests before features. Every behaviour here is
a pure function or a rendering rule, so the cost of writing tests first is low and the payoff on the
Phase 5 relocation is high.

## Format: `[ID] [P?] [Story] Description`

* **[P]**: Can run in parallel (different files, no dependencies)
* **[Story]**: Which user story this task belongs to
* **🔒**: Gated on the licensing question in the spec's Licensing Constraints section

## Delivery order inverts story priority — deliberately

The template orders phases by story priority. This feature does not, and the reason is recorded in
`plan.md`: User Story 3 (P3) is the only story that is **not** gated on an unresolved licensing
question, and it is independently shippable. US1 (P1) and US2 (P2) are both gated, because both
require substitution to remain a feature at all.

So Phase 4 delivers US3 first as the real MVP, and the gated stories follow. If the licensing answer
comes back "do not alter the text", Phases 5 and 6 are dropped and Phase 4 is already the correct
end state — the default is right and only the substitution path needs removing.

---

## Phase 1: Setup

**Purpose**: Lock current behaviour before anything moves.

- [ ] T001 Extend `packages/api/src/lib/spelling.test.ts` with characterisation tests covering all
      three capitalisation forms (`labor`→`labour`, `Labor`→`Labour`, `LABOR`→`LABOUR`), markup
      pass-through (a `<b>` tag inside verse HTML survives untouched), multi-word exclusion, and the
      Canadian-keeps-`realize` case, so the Phase 5 relocation is provably behaviour-preserving
- [ ] T002 [P] Add a `Dialect` round-trip test in `packages/api/src/lib/spelling.test.ts` asserting
      that `american` returns its input byte-for-byte

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared pieces every story below needs.

**⚠️ No story work begins until this phase completes.**

- [ ] T003 Add `resolveDialect(value: unknown): Dialect` to `packages/api/src/lib/spelling.ts`,
      mapping any value outside the enumeration `'american' | 'british' | 'canadian'` to
      `'american'` per FR-010, and unit-test it in `packages/api/src/lib/spelling.test.ts`
- [ ] T004 Route `RENDER_DIALECT` parsing in `packages/api/src/index.ts` through `resolveDialect`,
      replacing the inline `.includes()` check so a bad value cannot reach rendering

**Checkpoint**: Dialect values are validated in exactly one place.

---

## Phase 3: Tranche A — Attribution (cross-cutting, ungated)

**Purpose**: The disclosure component, needed by US3 (its absence) and US1 (its presence).

- [ ] T005 [P] Write tests in `apps/web/src/components/ScriptureAttribution.test.ts` asserting the
      component renders the publisher attribution alone for `american`, and attribution plus a
      notice naming the dialect for `british`/`canadian` (FR-014, FR-015)
- [ ] T006 Create `apps/web/src/components/ScriptureAttribution.vue` rendering the NKJV attribution
      from `NOTICE.md`, plus a conditional disclosure that names the applied dialect, attributes the
      change to verse-vault rather than the publisher, and states the text is not the published
      wording (FR-014)
- [ ] T007 Mount `ScriptureAttribution.vue` wherever the NKJV citation appears today — the footer
      and the About/Stats surface in `apps/web/src/views/StatsView.vue` — replacing the static
      citation text
- [ ] T008 Update `NOTICE.md` to describe the modification disclosure alongside the constraints it
      already lists, so the notice file and the running product agree

**Checkpoint**: The disclosure exists and is correct for any dialect it is handed.

---

## Phase 4: User Story 3 — The published text arrives by default (Priority: P3) 🎯 MVP

**Goal**: A reader who has chosen nothing sees exactly what the publisher printed, under an
unqualified attribution.

**Independent Test**: With no `RENDER_DIALECT` set and a reader who has never opened preferences,
open a verse containing `labor` and see `labor`, with no modification notice.

**This phase is the shippable increment and is not gated.**

### Tests for User Story 3

- [ ] T009 [P] [US3] Add a test in `packages/api/src/lib/render.test.ts` asserting `composeRender`
      with no dialect argument returns text identical to the source chapter HTML (SC-009, US3/AC1)
- [ ] T010 [P] [US3] Add a test in `packages/api/src/routes/cards.test.ts` asserting an unconfigured
      deployment serves unsubstituted text from `GET /api/cards/:cardId`

### Implementation for User Story 3

- [ ] T011 [US3] Change `DEFAULT_DIALECT` in `packages/api/src/lib/spelling.ts` from `'canadian'` to
      `'american'` per FR-009, so an unconfigured deployment serves the published text
- [ ] T012 [US3] Verify no caller of `composeRender` in
      `packages/api/src/routes/{cards,materials}.ts` supplies a hard-coded dialect that would defeat
      T011
- [ ] T013 [US3] Add a `packages/api/CHANGELOG.md` `[Unreleased]` entry recording that the default
      rendering dialect changed and that an unconfigured deployment now serves the published text

**Checkpoint**: US3 complete. Shippable on its own. If licensing forbids substitution, stop here and
remove the substitution path.

---

## Phase 5: User Story 1 — Reader opts into their dialect (Priority: P1) 🔒

**Goal**: A reader who selects a dialect sees scripture spelled that way, with the modification
disclosed.

**Independent Test**: Set a reader to Canadian; open a verse containing `labor` and see `labour`,
with `realize` unchanged and the disclosure showing.

**🔒 Gated**: requires the licensing question resolved in favour of substitution.

### Tests for User Story 1

- [ ] T014 [P] [US1] Port the characterisation tests from T001 to
      `apps/web/src/lib/spelling/spelling.test.ts`, unchanged in substance, so the relocated
      implementation is held to the same behaviour
- [ ] T015 [P] [US1] Add a test asserting the derived Canadian dictionary contains `labor`→`labour`
      and does **not** contain `realize`, in `apps/web/src/lib/spelling/dictionary.test.ts`

### Implementation for User Story 1

- [ ] T016 [US1] Add a build-time dictionary derivation step producing one JSON artifact per target
      dialect from `varcon@1.0.1`'s `A.json`, applying the four derivation rules in `data-model.md`
      verbatim: key on the lowercased American form; drop entries whose American key contains a
      space; drop entries whose target variant contains a space; drop entries whose target variant
      equals the American form
- [ ] T017 [US1] Create `apps/web/src/lib/spelling/index.ts` exporting
      `applyDialect(text: string, dialect: Dialect): string`, moved from
      `packages/api/src/lib/spelling.ts` with behaviour unchanged, loading its dictionary lazily so
      `american` fetches nothing (research R2)
- [ ] T018 [US1] Remove dialect application from `packages/api/src/lib/render.ts` — `composeRender`
      stops taking a `dialect` argument and always emits the published text (research R1, contract
      "Render payload — a removal")
- [ ] T019 [US1] Drop the now-unused `dialect` threading from
      `packages/api/src/routes/{cards,materials}.ts` and `packages/api/src/app.ts`
- [ ] T020 [US1] Apply the reader's dialect at display time in
      `apps/web/src/lib/engine/engineStore.ts` after the IDB `renders` cache read, so cached
      payloads stay dialect-free (research R1)
- [ ] T021 [US1] Pass the reader's effective dialect into `ScriptureAttribution.vue` so the
      disclosure from Phase 3 appears whenever substitution is active (FR-014)
- [ ] T022 [US1] Add a `packages/api/CHANGELOG.md` `[Unreleased]` entry recording that rendered HTML
      from the API is now always the published text, same shape, changed guarantee

**Checkpoint**: A reader can see a dialect, and the server no longer emits altered scripture.

---

## Phase 6: User Story 2 — The choice is the reader's own (Priority: P2) 🔒

**Goal**: Each reader's dialect applies only to their own view.

**Independent Test**: Two readers on one deployment, different dialects, same verse, no crossover
after reload.

**🔒 Gated**: same condition as Phase 5. Depends on Phase 5.

### Tests for User Story 2

- [ ] T023 [P] [US2] Add contract tests in `packages/api/src/routes/account.test.ts` for
      `GET /api/preferences` and `PUT /api/preferences` per `contracts/dialect-preference.md`,
      including the deliberate asymmetry: a bad **write** returns `400`, a bad **stored** value
      resolves to the default rather than failing the read
- [ ] T024 [P] [US2] Add a test asserting `GET /api/preferences` returns `effectiveDialect` as a
      non-null member of the enumeration even when `dialect` is null

### Implementation for User Story 2

- [ ] T025 [US2] Add a `user_preferences` table to `packages/api/src/db/schema.ts`: `user_id` text
      primary key referencing `user.id` with cascade delete, `dialect` text **nullable** (null means
      no preference expressed), `updated_at` integer unix seconds — per `data-model.md`
- [ ] T026 [US2] Write the Drizzle migration in `packages/api/migrations/`, remembering
      `--> statement-breakpoint` between statements per the CLAUDE.md gotcha
- [ ] T027 [US2] Implement `packages/api/src/lib/user-preferences.ts` with read and write helpers
      that resolve an absent row and a null `dialect` identically to the deployment default
- [ ] T028 [US2] Add `GET /api/preferences` and `PUT /api/preferences` to
      `packages/api/src/routes/account.ts` per the contract
- [ ] T029 [US2] Add the dialect selector to `apps/web/src/views/SettingsPreferencesView.vue`,
      offering all three values and labelling the default
- [ ] T030 [US2] Create `apps/web/src/composables/useDialect.ts` exposing the reader's effective
      dialect, fetched once on boot, and point T020's display-time substitution at it
- [ ] T031 [US2] Route both the displayed text and the recitation diff's canonical side in
      `apps/web/src/components/CardPrompt.vue` through a **single** `applyDialect` call site, so
      FR-013 holds by construction rather than by two call sites agreeing

**Checkpoint**: All three stories functional and independent.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T032 [P] Update the `## Spelling dialects` entry in `docs/unspecced.md` to point at
      `specs/001-spelling-dialects/`, satisfying the Constitution Principle I action recorded in
      `plan.md`
- [ ] T033 [P] Remove the now-dead `toCanadian` convenience alias from the relocated spelling module
      if nothing calls it
- [ ] T034 Run every scenario in [quickstart.md](./quickstart.md), especially Scenario 3 (two
      readers, no cache crossover) and Scenario 7 (server serves published text) — those two are the
      regression tests for research decision R1
- [ ] T035 Confirm `pnpm test`, `cargo clippy --all-targets -- -D warnings`, `dprint check`, and
      `typos` all pass per Constitution Principle IV

---

## Dependencies & Execution Order

### Phase Dependencies

* **Phase 1 (Setup)**: no dependencies
* **Phase 2 (Foundational)**: depends on Phase 1; blocks everything below
* **Phase 3 (Attribution)**: depends on Phase 2; ungated
* **Phase 4 (US3)**: depends on Phases 2 and 3; **ungated — ship this alone**
* **Phase 5 (US1)**: depends on Phase 4; 🔒 gated on licensing
* **Phase 6 (US2)**: depends on Phase 5; 🔒 gated on licensing
* **Phase 7 (Polish)**: depends on whichever phases shipped

### Critical sequencing note

T018 (server stops substituting) and T020 (client starts substituting) **must land together**.
Between them, readers on a non-default dialect see American spelling — a visible regression. Treat
them as one commit or one PR, not two.

### Parallel Opportunities

* T001 and T002 in Setup
* T005 (attribution tests) alongside Phase 2
* T009 and T010 in Phase 4
* T014 and T015 in Phase 5
* T023 and T024 in Phase 6
* T032 and T033 in Polish

---

## Implementation Strategy

### MVP — Phase 4, not Phase 5

Setup → Foundational → Attribution → US3. That is the whole ungated increment: the product ships the
published text by default, and the disclosure exists for any deployment that opts into a dialect via
`RENDER_DIALECT`. It is defensible on its own merits whatever the licensing answer turns out to be.

**Stop and validate here.** Quickstart Scenario 1 is the acceptance test.

### Gated increments

Phases 5 and 6 need the licensing question answered first. Doing them in order gives two
demonstrable steps — substitution works client-side, then it is per-reader — but neither is worth
starting while the answer is outstanding, since Phase 6 in particular is the expensive half.

### If the answer is no

Drop Phases 5 and 6. Remove `applyDialect` and its callers, drop the `RENDER_DIALECT` variable, and
simplify `ScriptureAttribution.vue` back to the unconditional citation. Phase 4 has already put the
default where it needs to be, so nothing done to that point is wasted.
