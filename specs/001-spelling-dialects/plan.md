# Implementation Plan: Spelling Dialects for Rendered Scripture

**Branch**: `chore/add-spec-kit` (retrofit) | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-spelling-dialects/spec.md`

## Summary

Substitution itself ships and works. What does not exist is everything the spec added around it: a
per-reader preference (FR-008), a source-dialect default (FR-009), and a modification disclosure
(FR-014 to FR-016).

The central technical decision is **where substitution runs**. It is server-side today, which was
fine for a single deployment-wide dialect and breaks under a per-reader one — the render caches key
on card identity, not on reader, so two readers with different dialects would serve each other stale
spellings. Moving substitution to the client resolves that, collapses three cached variants back to
one, and puts the server permanently out of the business of emitting altered scripture, which is the
better licensing posture regardless of how the open question in the spec resolves.

The work sequences into a defensive tranche that stands on its own and a per-reader tranche gated on
the licensing answer.

## Technical Context

**Language/Version**: TypeScript 5.x on Node `^20.19.0 || >=22.12.0`; Vue 3.5 + Vite on the client

**Primary Dependencies**: `varcon@1.0.1` (dialect vocabulary), Hono (API), Drizzle + better-sqlite3
(persistence), Vue 3 SFCs (client)

**Storage**: SQLite. Dialect is a per-user preference and does not belong in `user_year_settings`,
which is keyed per `(user, material)` — see Data Model.

**Testing**: `vitest` for both `packages/api` and `apps/web`. No `cargo test` involvement: this
feature touches no Rust.

**Target Platform**: Node server on a VPS; browser SPA; Tauri desktop shell running the same bundle

**Project Type**: Web application — TypeScript API plus a Vue fat client.

**Performance Goals**: Substitution runs on every rendered verse. The Canadian dictionary is 4,864
entries; a verse is tens of words. Per-verse cost must stay imperceptible against the existing
render path, which already does DOM extraction and tokenisation.

**Constraints**:

* The derived dictionaries are 451 KB (British) and 125 KB (Canadian) uncompressed. They MUST NOT
  enter the initial bundle. Load the one dialect a reader selected, on demand; `american` loads
  nothing.
* The 30-day api.bible cache TTL and the no-bulk-extraction rule apply to anything cached. Moving
  substitution client-side must not change what is cached or for how long — only what is done to it
  at display time.
* FR-013: the typed-recitation diff and the displayed text must share a dialect.

**Scale/Scope**: One deployment, a handful of readers, three dialects. Small.

## Constitution Check

_GATE: evaluated before Phase 0 and re-evaluated after Phase 1._

| Principle                               | Assessment                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **I. Design Docs Are Source of Truth**  | **Action required.** The feature has no doc in `docs/`. `spec.md` is now the statement of intent, but `docs/unspecced.md` still lists spelling dialects as uncovered. That entry must be updated to point at this spec when the work lands, or the index lies.                                                                                                                                               |
| **II. Pure Core, Thin Edges**           | **Pass.** Substitution is presentation, not memory modelling, credit assignment, or scheduling, so it does not belong in `crates/core` and putting it in TypeScript violates nothing. The relocation must be a **move**, not a copy: leaving substitution on the server while adding it to the client would create two implementations of one behaviour, which is the spirit of what this principle forbids. |
| **III. Contract Versions Are Promises** | **Pass, with a caveat.** No change to `crates/{core,wasm}/src/`, so no contract bump. The caveat is that the render payload shape is a de-facto contract between API and client; changing it needs the API changelog entry that `packages/api` requires anyway.                                                                                                                                              |
| **IV. Validate Before You Ship**        | **Pass.** No scheduling change, so `crates/sim` is not involved. Tests-first applies: substitution, capitalisation, markup safety, and the disclosure are all pure functions or pure rendering, and cheap to test before implementing.                                                                                                                                                                       |
| **V. Atomic, Traceable History**        | **Pass.** The two tranches below are separable, and within them each change is independently committable.                                                                                                                                                                                                                                                                                                    |

No violations requiring justification. The Complexity Tracking table is therefore omitted.

## Sequencing

The tranches exist because the spec records an unresolved licensing question, and one tranche is
worth building whatever the answer is while the other is not.

### Tranche A — defensive (not gated)

Satisfies FR-009 and FR-014 to FR-016. Holds even if the licensing answer is "do not alter the
text": in that case the default is already correct and only the substitution path is removed.

1. Flip `DEFAULT_DIALECT` to `american`, so an unconfigured deployment serves the published text.
2. Add the modification disclosure to the attribution surface, conditional on an active dialect.
3. Update `NOTICE.md` to describe the disclosure alongside the constraints it already lists.

### Tranche B — per-reader (gated on the licensing answer)

Satisfies FR-008, and FR-016's per-reader half. This is the expensive tranche and the one wasted if
the feature has to be withdrawn.

4. Move substitution from server to client (see Research decision R1).
5. Add the per-user dialect preference: storage, API, settings UI.
6. Thread the reader's dialect through the client render path and the recitation diff together, so
   FR-013 holds by construction.

## Project Structure

### Documentation (this feature)

```text
specs/001-spelling-dialects/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── dialect-preference.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Created by /speckit-tasks, not by this command
```

### Source Code (repository root)

```text
packages/api/
├── src/
│   ├── lib/
│   │   ├── spelling.ts        # Substitution; shrinks to a shared dictionary builder
│   │   ├── render.ts          # composeRender — stops applying dialect (Tranche B)
│   │   └── user-preferences.ts  # NEW — per-user dialect read/write
│   ├── routes/
│   │   ├── account.ts         # NEW endpoints for the preference
│   │   ├── cards.ts           # Stops threading dialect into composeRender
│   │   └── materials.ts       # Same, plus the bulk /renders path
│   ├── db/schema.ts           # NEW user_preferences table
│   └── index.ts               # RENDER_DIALECT becomes the deployment default only
└── migrations/
    └── 00NN_user_preferences.sql   # NEW

apps/web/
└── src/
    ├── lib/
    │   ├── spelling/          # NEW — client-side substitution + lazy dictionaries
    │   └── diff/wordDiff.ts   # Canonical side must use the reader's dialect (FR-013)
    ├── composables/useDialect.ts   # NEW — reader's current dialect
    ├── components/
    │   ├── CardPrompt.vue     # Applies dialect to displayed + expected text together
    │   └── ScriptureAttribution.vue  # NEW — attribution plus conditional disclosure
    └── views/SettingsPreferencesView.vue   # Dialect selector
```

**Structure Decision**: Existing web-application layout — `packages/api` for the server, `apps/web`
for the client. No new packages. The only structural addition is a `spelling/` directory under
`apps/web/src/lib` to hold the substitution logic and its lazily-loaded dictionaries once Tranche B
moves it off the server.
