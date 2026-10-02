# Implementation Plan: Proofread Recitation Diff

**Branch**: `feat/proofread-diff` | **Date**: 2026-10-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-proofread-recitation-diff/spec.md`

## Summary

Replace the type-to-recite word diff on the card back with a proofread view of the typed answer:
matched words in the verse colour, every mistake with the verse's words above it and the reader's
struck words or a caret below, reworded phrases merged into one correction, and a plain-verse
fallback when the reader recited the wrong verse. Typed club lists get the same look, per number.

The comparison (`wordDiff`) keeps its rules and gains one tie-break fix, landed first as its own
commit (research R11). A new pure module turns its output into edits and decides merge and fallback,
so the spec's reference cases are unit-tested. The existing `diffHtml` computed in `CardPrompt.vue`,
already shared by all three typed card kinds, renders those edits. Styling follows the signed-off
mockups. The feature also writes the first doc for type-to-recite.

## Technical Context

**Language/Version**: TypeScript 5.9, Vue 3.5 single-file components, Vite 7

**Primary Dependencies**: None new. Reuses `wordDiff` and `normaliseClubListAnswer` in
`apps/web/src/lib/diff/`.

**Storage**: N/A. Everything is derived on the card back and discarded.

**Testing**: `vitest` in `apps/web` for the `wordDiff` tie-break (its first test file), the pure
edit logic, and the club-list ordering. No component-test setup exists, and none is added; visual
requirements are checked by hand via [quickstart.md](./quickstart.md). No Rust involvement.

**Target Platform**: Browser SPA, plus the Tauri desktop shell running the same bundle.

**Project Type**: Web application, client-only change.

**Performance Goals**: Imperceptible. A verse is tens of words and the diff already runs on flip;
edit grouping and merging are single linear passes over its output.

**Constraints**:

* No layout measurement in JavaScript; marks are in-flow stacks sized by CSS alone (research R4).
* Light and dark themes through the existing tokens plus one new one (R5).
* Phone width with no sideways scroll (FR-017).
* Expected text stays in the reader's dialect (spec 001 FR-013); untouched because `expectedText` is
  unchanged.

**Scale/Scope**: Three card kinds on one component, one new library module, one new doc.

## Constitution Check

_GATE: evaluated before Phase 0 and re-evaluated after Phase 1._

| Principle                               | Assessment                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I. Design Docs Are Source of Truth**  | **Action required, planned.** Type-to-recite has no doc. The feature adds `docs/type-to-recite.md`, lists it in `CLAUDE.md`, and points `docs/unspecced.md`'s club-list diffing mention at it (R9).                       |
| **II. Pure Core, Thin Edges**           | **Pass.** Presentation only. No memory modelling, credit assignment, or scheduling, and nothing crosses the WASM boundary.                                                                                                |
| **III. Contract Versions Are Promises** | **Pass.** No change to `crates/{core,wasm}/src/`. No contract bump.                                                                                                                                                       |
| **IV. Validate Before You Ship**        | **Pass.** No scheduling change, so `crates/sim` is not involved. The edit logic is pure and gets tests first, from the spec's reference cases. `pnpm test`, `dprint check`, and `typos` run before push.                  |
| **V. Atomic, Traceable History**        | **Pass.** Work splits into self-contained commits: edit logic with tests, club-list ordering with tests, rendering and styles, doc, release.                                                                              |
| **VI. No Client Can Get Stuck**         | **Pass.** No persisted state, no sync, no identifiers.                                                                                                                                                                    |
| **VII. Simplest Design That Works**     | **Pass.** One new module, for logic that must be testable; rendering stays in the existing shared computed rather than a new component (R2). One new token. Every new export has a production caller in `CardPrompt.vue`. |

No violations. Complexity Tracking is omitted.

**Post-design re-check**: unchanged. Phase 1 added no modules, options, or state beyond those named
above; the data model is derived values only, and the contract fixes semantic elements without
prescribing structure.

## Project Structure

### Documentation (this feature)

```text
specs/004-proofread-recitation-diff/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   └── card-back-markup.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Created by /speckit-tasks, not by this command
```

### Source Code (repository root)

```text
apps/web/
├── src/
│   ├── lib/diff/
│   │   ├── wordDiff.ts          # Typed-side tie-break only (R11)
│   │   ├── wordDiff.test.ts     # New: the run-together case
│   │   ├── <new module>         # Edits, merge, match measures (R1)
│   │   ├── <new module tests>   # Seven reference cases + threshold boundaries
│   │   ├── clubList.ts          # Gains ascending order inside edit runs (R7)
│   │   └── clubList.test.ts     # Covers the ordering
│   ├── components/CardPrompt.vue  # diffHtml renders edits + fallback; diff styles replaced
│   └── assets/colors.css        # --color-mark-line, light and dark (R5)
└── CHANGELOG.md                 # MINOR entry
docs/type-to-recite.md           # New (R9)
docs/unspecced.md                # Club-list diffing mention points at the new doc
CLAUDE.md                        # Lists the new doc
```

**Structure Decision**: Client-only change inside `apps/web`, following the existing split of pure
diff logic in `lib/diff/` and rendering in `CardPrompt.vue`. Placeholders mark where the new module
goes; its name is the implementation's choice (Principle VII).

## Reuse and Ownership

| Decision or write path                                        | Owner (existing symbol, or file and responsibility if new)                   | Existing code reused                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Which words match, are missing, or are extra                  | `wordDiff` in `apps/web/src/lib/diff/wordDiff.ts`, plus the R11 tie-break    | All of it, including the earliest-match traceback                      |
| Grouping diff items into replace / add / skip edits           | New module in `apps/web/src/lib/diff/`                                       | `DiffItem` type; `normalize` for letter counts                         |
| Whether two edits merge across a glue run (FR-010)            | Same new module                                                              | `normalize`                                                            |
| Whether the wrong-verse fallback applies (FR-011), and N of M | Same new module                                                              |                                                                        |
| Club-list order inside edit runs (FR-012)                     | `apps/web/src/lib/diff/clubList.ts`, beside `normaliseClubListAnswer`        | Existing module and its test file                                      |
| Card-back HTML for typed answers, including fallback body     | `diffHtml` computed in `CardPrompt.vue`                                      | `escapeHtml`, `verseHtml`, `verseColourVar`, `verseNumberSpan` pattern |
| Which reveal branches show the typed-answer body              | Existing `v-if="diffItems"` in the Recitation, Ftv, ChapterClubList branches | Template unchanged                                                     |
| Expected text and typed text fed to the diff                  | Existing `expectedText` and `userInputForDiff` computeds                     | Unchanged, including Ftv prefix stripping and dialect                  |
| Mark, label, and caret styles                                 | `CardPrompt.vue` scoped styles, replacing `.diff-missing` and `.diff-extra`  | `--active-verse-colour`, `--color-text`, `--color-bg-card`             |
| Strikethrough and caret colour                                | New `--color-mark-line` in `apps/web/src/assets/colors.css`                  | Existing light block and dark media block                              |

**Platform already provides**: `--active-verse-colour` is set per card on `.card-box` and per number
by `verseNumberSpan`, so labels inherit the right colour with no new plumbing. `<del>` strikes text
by default and, with `<ins>`, is exposed to assistive technology. Vue's `v-html` is already how the
three branches render the diff. `normaliseClubListAnswer` already sorts typed club lists and passes
unparsable input through raw.

**Releases**: `@verse-vault/web` MINOR. No contract crates, no API.

## Sequencing

1. `wordDiff` tie-break, test first (R11). A fix to today's diff, so it stands alone.
2. Edit logic, test first: grouping, merge, match measures, against the reference cases.
3. Club-list ordering inside edit runs, test first.
4. Rendering: `diffHtml` produces the proofread body, the fallback body, and the club-list body;
   styles and the new token replace the old diff styles.
5. Doc: `docs/type-to-recite.md`, `CLAUDE.md`, `docs/unspecced.md`.
6. Release: changelog and version bump.

Each step is its own commit. Steps 1 to 3 are independent; step 4 needs all three.
