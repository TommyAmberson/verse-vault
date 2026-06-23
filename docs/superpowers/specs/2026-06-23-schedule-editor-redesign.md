# Schedule Editor Redesign — Responsive Ledger ↔ Card

> **For:** a Claude Code implementation session on `verse-vault`. **Suggested repo path:**
> `docs/superpowers/specs/2026-06-23-schedule-editor-redesign.md` **Branch:**
> `fix/schedule-clone-reactive-proxy` (or its successor on master). **Visual reference:** the
> interactive mockup `Schedule Redesign — Responsive (A+B).dc.html` (a standalone HTML file — open
> it and drag the handle on the right edge to watch the layout morph through all three regimes). A
> proven, copy-pasteable CSS skeleton is in §6 below.

---

## 1. TL;DR

Rebuild `ScheduleEditorView.vue` so the schedule is **one layout that reflows by width** instead of
a fixed-width 4-column table. Wide, it's the printable ledger
(`DATE | PASSAGE | CLUB 150 | CLUB 300`). As the available width shrinks it folds — first onto a
date rail, then into one card per week — with verse numbers turning from a comma list into pills.
Editing **expands the clicked week in place** at every width (no side pane — that adjacency was the
bug). As part of the same change, fix the data model so a week can hold **more than one passage**,
each with its own 150/300 verse sets.

---

## 2. Background

### 2.1 What exists today

* **View file:** `apps/web/src/views/ScheduleEditorView.vue` (~1300-line single SFC).
* **Data helpers:** `apps/web/src/lib/schedule.ts` (pure data, no Vue).
* **API contract / validation:** `packages/api/src/lib/schedules.ts`.
* **Route:** `/schedule/:materialId` (e.g. `/schedule/nkjv-cor`).
* **Layout today:** a 4-column table (`DATE | PASSAGE | CLUB 150 | CLUB 300`) with month-name
  section headers and inline full-width meet rows. **View mode** is read-only; **edit mode** opens a
  form pane _to the right of the table_.
* **Design context:** Phase 3 design doc at
  `docs/superpowers/specs/2026-06-14-schedules-and-settings-design.md` (read it — it defines the
  data model and editor behaviour this builds on).

### 2.2 Data shape (current)

```ts
Schedule {
  version: number;
  materialId: string;
  season: string;
  title: string;
  meetingDayOfWeek: number;
  weeks: Week[];
  meets: Meet[];
}

Week {
  date: string;                 // ISO date
  passage: SchedulePassage | null;
  verses: { club150?: number[]; club300?: number[] } | null;
  isReview: boolean;
}

Meet {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  location: string;
}
```

### 2.3 What's actually wrong (the diagnosis)

The user's report — _"edit view has pieces that overflow out the side"_ — is **not a width bug, it's
an adjacency bug.** Edit mode puts a form pane _beside_ a table that already wants the full
viewport. Two full-width things can't share a row, so something overflows. No amount of column-width
tuning fixes a layout whose two halves each want the whole width.

### 2.4 What was already tried and explicitly rejected

Two commits chased the symptom by resizing columns/grids:

* `cb529d1` — _fix(web): widen edit-mode schedule editor_
* `a6ebf61` — _fix(web): shrink schedule table to content width_

**The user has said both are bad. Do not start from width/sizing tweaks.** These should be reverted
(see §10).

### 2.5 Known data-model limitation to fix here

Verses are keyed flatly as `club150 / club300` on the week, with a single `passage`. Some weeks (the
NT Survey schedule) cover **two passages**, each with its own 150/300 sets — rendered in the
printable PDF as a `|` splitting the verse groups. The flat shape **cannot represent this**; the
pairing is lost. This redesign fixes it (§7). _In scope per the user._

---

## 3. The redesign

### 3.1 Core principle

**One structure, three densities, driven by the width of the schedule container — not the
viewport.** Use CSS **container queries** (`container-type: inline-size`) on the schedule wrapper so
it reflows correctly inside _any_ context (full page, split pane, a future side-by-side), and so
edit-mode can never reintroduce the overflow.

The atomic unit is a **passage block**: `{ passage, club150[], club300[] }`. A week is an ordered
list of one or more blocks (§7). The layout iterates blocks; single- and multi-passage weeks share
one code path.

### 3.2 The three regimes

| Container width | Name          | Layout                                                                                                                            | Verse numbers                        |
| --------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **≥ 790px**     | **Ledger**    | Four aligned columns: `DATE · PASSAGE · CLUB 150 · CLUB 300`. Flat rows, hairline separators. Matches the printable PDF.          | Plain comma list (`1, 6, 7, 10, 23`) |
| **520–789px**   | **Condensed** | Date moves to a narrow left rail; passage + both verse sets stack to its right. Light card chrome. The tablet / split-pane width. | Pills                                |
| **< 520px**     | **Cards**     | One self-contained card per week: date badge, passage, 150 row, 300 row.                                                          | Pills (tap target)                   |

**Breakpoints:** `790px` and `520px` (container widths). Rationale: below ~790 the four columns
crowd once verse lists get long; below ~520 a two-column date-rail stops fitting and single-column
cards read better. Both are one-line constants — easy to tune after seeing real data. _(Chosen for
you per "decide for me.")_

### 3.3 What morphs, precisely

* **The week row** is the same DOM at every width; only its grid template and a few display toggles
  change.
  * Ledger: `grid-template-columns: 90px 1.5fr 2fr 2fr;` children flow into the 4 columns. For a
    **multi-passage** week, the date cell spans all block-rows (`grid-row: 1 / span N`) and each
    block contributes a `(passage, 150, 300)` triple — so two passages stack under one date,
    mirroring the PDF's `|`.
  * Condensed: `grid-template-columns: 78px 1fr;` date spans the block rows in column 1; passage and
    verse rows stack in column 2.
  * Cards: single column; date becomes a small mono badge at the top of the card.
* **Verse numbers** are always the same `<span>` per number. Ledger strips the pill styling and adds
  `::after { content: ", " }`; condensed/cards render them as pills. One source, two appearances.
* **Column header row** (`DATE / PASSAGE / CLUB 150 / CLUB 300`) shows only in Ledger; hidden
  otherwise (the pill labels `150` / `300` take over).
* **Month section headers** persist at all widths (italic serif), with tighter padding in Ledger.
* **Review weeks** render as a muted row (Ledger) or a dashed muted card (Condensed/Cards).
* **Meet rows** are always full-width blocks (clay accent): a date badge + name + location.

### 3.4 Verse number display _(decided)_

Comma list when wide (Ledger — PDF-faithful and dense), pills when narrow (Condensed/Cards —
scannable, and a real tap target for editing on touch). This is the morph the user liked; keep it.

### 3.5 Edit interaction _(decided)_

**Expand-in-place at every width.** Clicking/tapping a week opens an inline editor where that week
sits — the row/card grows into a form (date, passage, Club 150 chips, Club 300 chips, add/remove).
Save/Cancel live in the expanded region. No side pane, no separate edit screen → **nothing to
overflow.**

* Wide: the form opens as a panel spanning the table width, with a left accent rule and a tinted
  background, pushing rows below it down.
* Narrow: the same form, in the expanded card (accordion).
* A **bottom sheet** (form sliding up over a dimmed list on phones) was considered and **deferred**
  — it's a second interaction model for marginal gain. Revisit only if accordion editing feels
  cramped on real devices.
* Multi-passage editing: the editor shows one block per passage with an **"Add passage"** affordance
  and a remove control per block.

### 3.6 Print _(future, not now)_

Out of scope for this pass. When wanted: an `@media print` stylesheet that forces the Ledger layout
regardless of container width, hides app chrome (nav, mode toggle, edit affordances), and sets page
margins to match the PDFs. Note it in code with a `TODO(print)` near the container-query block.

---

## 4. Goals / non-goals

**Goals**

* No horizontal overflow at any width, in view **or** edit mode.
* Visually faithful to the printable ledger when there's room.
* Genuinely usable on a phone (cards + pills + accordion edit).
* Multi-passage weeks render and edit correctly.
* Editing and viewing remain **distinct modes** (per the user), but both redesigned and sharing the
  responsive layout.

**Non-goals**

* Print stylesheet (future).
* Bottom-sheet editing (future).
* Any change to meets' data model.
* Reworking routing, auth, or data-fetching.

---

## 5. Files to touch

| File                                                                 | Change                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/views/ScheduleEditorView.vue`                          | Replace the table markup + edit-pane with the responsive container-query layout; convert edit to expand-in-place; render weeks by iterating passage **blocks**; add Club-150/300 chip editors and "Add passage". |
| `apps/web/src/lib/schedule.ts`                                       | Update `Week` type to use `blocks` (§7); add a `migrateWeek`/`migrateSchedule` helper; update any week/verse accessors and `cloneSchedule`.                                                                      |
| `packages/api/src/lib/schedules.ts`                                  | Update server-side validation/zod (or equivalent) for the new week shape; bump `Schedule.version`; validate migration on read.                                                                                   |
| `docs/superpowers/specs/2026-06-14-schedules-and-settings-design.md` | Add a short addendum (or link this doc) noting the model change.                                                                                                                                                 |

> ⚠️ **Verify the exact `SchedulePassage` type and any existing migration/versioning machinery by
> reading the files first** — §7 is written from the data shapes in the brief, not from the live
> source. Adjust the migration to match whatever pattern the repo already uses for `version` bumps.

---

## 6. Reference implementation (proven CSS skeleton)

This is the exact technique from the approved mockup, condensed. Adapt the class names / scoping to
the SFC's `<style scoped>`. The single-passage case is shown; the multi-passage extension is the
date `grid-row: 1 / span N` note in §3.3.

```css
/* The schedule is its own query container — reflows by its OWN width,
   so it behaves correctly in a split pane or expanded edit state. */
.sched { container-type: inline-size; }

/* ---------- BASE = narrow / CARD (mobile-first) ---------- */
.col-head { display: none; }                 /* header row only in ledger */
.sched-body { display: flex; flex-direction: column; gap: 9px; padding: 14px; }

.wk {                                         /* one week */
  display: flex; flex-direction: column; gap: 9px;
  background: #fff; border: 1px solid #eae5db; border-radius: 12px; padding: 14px 15px;
}
.wk .c-date { font: 500 11px/1 'IBM Plex Mono', monospace;
  letter-spacing: .1em; text-transform: uppercase; color: #a76a4c; }
.wk .c-pass { font: 500 19px/1.1 'Spectral', Georgia, serif; }

.c-150, .c-300 { display: flex; gap: 9px; align-items: baseline; flex-wrap: wrap; }
.lbl { font: 700 10px/1 'Public Sans', sans-serif; letter-spacing: .06em; flex: 0 0 30px; }
.c-150 .lbl { color: #38507a; }  .c-300 .lbl { color: #a76a4c; }
.vals { display: flex; flex-wrap: wrap; gap: 6px; }
.v { font: 12.5px 'IBM Plex Mono', monospace; padding: 2px 7px; border-radius: 5px;
  background: #eef2f7; color: #38507a; }     /* pill */
.c-300 .v { background: #f4ece5; color: #a76a4c; }

/* ---------- CONDENSED: date rail appears ---------- */
@container (min-width: 520px) {
  .sched-body { gap: 7px; }
  .wk { display: grid; grid-template-columns: 78px 1fr; gap: 7px 16px; align-items: baseline; }
  .wk .c-date { grid-row: 1 / span 3; align-self: start; }  /* span = #rows the week needs */
  .wk .c-pass, .c-150, .c-300 { grid-column: 2; }
}

/* ---------- LEDGER: full 4-column printable table ---------- */
@container (min-width: 790px) {
  .col-head { display: grid; grid-template-columns: 90px 1.5fr 2fr 2fr; gap: 18px;
    padding: 11px 18px; border-bottom: 1px solid #ece7dd;
    font: 11px 'Public Sans'; letter-spacing: .1em; text-transform: uppercase; color: #9a9489; }
  .sched-body { gap: 0; padding: 0; }
  .wk { display: grid; grid-template-columns: 90px 1.5fr 2fr 2fr; gap: 18px; align-items: baseline;
    background: transparent; border: none; border-top: 1px solid #f2eee5; border-radius: 0; padding: 9px 18px; }
  .wk .c-date { grid-row: auto; font-size: 13px; letter-spacing: 0; text-transform: none; color: #6b6c72; }
  .wk .c-pass { font-size: 16px; }
  .lbl { display: none; }                     /* labels live in .col-head now */
  .vals { display: block; }                   /* inline comma list */
  .v { background: transparent; padding: 0; color: #3a3b41; font-size: 13px; }
  .c-300 .v { background: transparent; color: #3a3b41; }
  .v:not(:last-child)::after { content: ", "; white-space: pre; }
}
```

**Palette / type used in the mockup** (adopt or map to the app's tokens):

* Paper `#fbfaf7`, card `#fff`, ink `#1f2024`, muted `#6b6c72`.
* Study-blue (Club 150) `#38507a`; meet/clay (Club 300 & meets) `#a76a4c`.
* Type: **Spectral** (passages, titles, month headers — serif), **Public Sans** (UI/labels), **IBM
  Plex Mono** (dates + verse numbers). Swap to the app's existing families if it has them; the
  _roles_ matter more than the exact faces.

---

## 7. Data-model change: multi-passage weeks

### 7.1 Problem

`Week.passage` (singular) + flat `Week.verses` can't express two passages each with their own
150/300 sets.

### 7.2 Proposed shape (recommended — clean replacement)

Introduce a **passage block** and make a week a list of them:

```ts
interface PassageBlock {
  passage: SchedulePassage;                       // a single reference
  verses: { club150?: number[]; club300?: number[] };
}

interface Week {
  date: string;
  blocks: PassageBlock[];   // 0 blocks = review/empty week; 1 = today's normal week; 2+ = multi-passage
  isReview: boolean;
}
```

* A normal week → exactly one block.
* A review/empty week → `blocks: []` (and `isReview: true`).
* A multi-passage week → 2+ blocks, rendered stacked under one date (Ledger) or as stacked sub-rows
  in the card (Condensed/Cards).

This is the cleanest option **and** it matches the layout, which already iterates blocks. The
`Schedule.version` field exists to support exactly this kind of migration.

### 7.3 Migration

Bump `Schedule.version` (e.g. `n → n+1`). On read, migrate old weeks:

```ts
function migrateWeek(old: any): Week {
  if (Array.isArray(old.blocks)) return old;           // already new
  const blocks = old.passage
    ? [{ passage: old.passage, verses: old.verses ?? {} }]
    : [];
  return { date: old.date, isReview: !!old.isReview, blocks };
}
```

Run it in the schedule loader (and/or a one-time data migration) so persisted documents upgrade
transparently. Mirror the validation in `packages/api/src/lib/schedules.ts`.

### 7.4 Lower-risk alternative (if migration is hairy)

Keep `passage` + `verses` for the single case and **add** an optional `passages?: PassageBlock[]`
that, when present, takes precedence. No migration, but two representations to validate and branch
on. Prefer §7.2 unless reading the source reveals migration is expensive.

### 7.5 Touch points for the model change

* `cloneSchedule` in `schedule.ts` must deep-clone `blocks` (relevant to the already-merged
  `a695de2` reactive-safe fix — make sure the clone stays reactive-safe with the new nested arrays).
* Any code reading `week.passage` / `week.verses` must move to `week.blocks[i].passage` / `.verses`.
* Server validation must accept `blocks` and reject the old shape post-migration (or accept both
  during a transition window).

---

## 8. Implementation plan (phased)

1. **Branch hygiene** (§10) — revert the two bad commits, take PR #102 to draft. Start clean.
2. **Data model** — update `Week` type + `PassageBlock`, write `migrateWeek`/`migrateSchedule`, bump
   `version`, update `cloneSchedule`, update `packages/api` validation. Land with unit tests on
   migration.
3. **Read-only responsive view** — rebuild the view-mode markup with the §6 container-query
   skeleton; iterate `blocks`; implement month headers, review rows, meet rows at all three regimes.
   Verify no overflow 320px → 1200px.
4. **Verse rendering** — comma list in Ledger, pills in Condensed/Cards (single source).
5. **Expand-in-place editor** — clicking a week opens the inline form; Club-150/300 chip add/remove;
   date + passage editing; Save/Cancel; **Add/Remove passage** for multi-block weeks. Reuse the
   responsive container so the editor never sits beside the table.
6. **Multi-passage QA** — load an NT Survey schedule (the `|` weeks); confirm two passages render
   stacked under one date and edit independently.
7. **Polish** — focus states, keyboard (Enter to add a verse chip, Esc to cancel), empty/loading
   states, transition when a row expands.
8. **(Future, separate PR)** print stylesheet; bottom-sheet editing if needed.

---

## 9. Acceptance criteria

* [ ] No horizontal scrollbar / clipped content at any width 320–1400px, in **view and edit** mode.
* [ ] At ≥790px the view reads as the 4-column printable ledger with comma verse lists.
* [ ] Between 520–789px the date is a left rail and verses are pills; nothing overflows.
* [ ] Below 520px each week is a single-column card with pill verses.
* [ ] Editing a week happens **in place**; the schedule is never rendered full-width beside the
      form.
* [ ] A two-passage week renders both passages, each with its own 150/300 sets, under a single date
      — and both are editable.
* [ ] Old persisted schedules load correctly via migration; `version` is bumped; round-trips through
      save without data loss.
* [ ] `cloneSchedule` remains reactive-safe with nested `blocks`.

---

## 10. Branch & PR housekeeping

**Conclusion:** revert the two symptom-chasing commits, keep the three genuine fixes, and take the
PR back to draft until the redesign lands.

* **Revert:** `cb529d1` (widen edit-mode), `a6ebf61` (shrink to content width).
* **Keep / land independently if desired:** `a695de2` (cloneSchedule reactive-safe), `6da5a37`
  (weekday spelling), `a09dc40` (printable table layout — the redesign supersedes its _visuals_ but
  its scaffolding/data wiring is still useful; keep unless it conflicts).
* **PR #102:** move back to **draft** (it currently contains the bad commits).

Suggested commands — **confirm order with `git log --oneline` first**, since the right tool depends
on whether the bad commits are on top:

```bash
git log --oneline -8                     # confirm the two bad commits are the most recent
# If they're the top two and the branch is yours to rewrite:
git rebase -i HEAD~5                      # drop the cb529d1 and a6ebf61 lines
# …or, non-destructive (safer on a shared PR branch):
git revert --no-edit cb529d1 a6ebf61
git push --force-with-lease               # only if you rebased
```

Then on GitHub: PR #102 → **Convert to draft**.

---

## 11. Open questions / risks

* **`SchedulePassage` shape** — confirm whether it's a string or a structured ref; the editor's
  passage field depends on it.
* **Existing migrations** — match the repo's established `version` bump pattern rather than
  inventing one.
* **Verse entry UX** — chip add/remove is assumed; if the source had a comma-string `<input>`,
  decide whether to keep that as the fast path and pills as the display.
* **Container-query support** — fine in all current evergreen browsers; confirm the app's
  browser-support floor. If sub-2022 browsers must be supported, fall back to a `ResizeObserver`
  width class on `.sched` (same breakpoints, JS-driven).
* **Block count for the Ledger date rowspan** — the `grid-row: 1 / span N` needs `N` = number of
  block rows; compute per week.
