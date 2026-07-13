# Passage Picker Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the schedule editor's bulky per-passage fieldsets and per-block summaries with an
inline horizontal picker row, hairline-separated multi-passage stacks, and a single week-level club
summary; drop the Review checkbox in favour of derived `blocks.length === 0` semantics.

**Architecture:** Pure client-side change. Template restructure inside
`apps/web/src/views/ScheduleEditorView.vue`, script-side aggregation helpers replacing the per-block
variants, style rewrite for the new picker row and summary layout. No wire-format change; no API
change; no Rust change. Falls back to the legacy 4-input grid when the material projection is empty
(dev without content pipeline).

**Tech Stack:** Vue 3 SFC (`<script setup>`), scoped CSS with container queries, TypeScript.
Existing colour tokens from `apps/web/src/assets/colors.css`.

## Global Constraints

* **Spec:** `docs/superpowers/specs/2026-07-13-passage-picker-redesign.md`.
* **No wire-format change.** `PassageBlock` still carries `passage` + `verses`; `week.isReview`
  still ships on every week — the UI just doesn't expose it as a user-editable toggle any more (§3,
  §2.4).
* **No new colour tokens or icons.** Use existing `--color-*` tokens verbatim.
* **Accessibility hard requirements:** every dropdown keeps a `<label for="…">` bound to it; the
  em-dash separator carries `aria-hidden="true"`; tab order is Book → Ch → Start → End → per-block ×
  remove → +Add-passage → per-week actions (§3).
* **Fallback stays.** When `materialPassages.value` is empty, the legacy four-input grid must still
  render — the picker's new inline row is the material-loaded path only (§2.1).
* **Contract crates and API untouched.** No `cargo` bumps, no `packages/api` version bump. Web
  changes ride the existing 0.8.x line; a chore/release commit at the end bumps `apps/web` to 0.9.0
  (visible UX change → MINOR).
* **Commit format:** Conventional Commits, subject ≤50 chars, imperative, lowercase after the
  type/scope prefix. Scope = `web` for every touching commit.
* **Atomicity:** One logical change per commit; commit as each task's checks pass.

---

## File Structure

Every change lands in a single file:

* `apps/web/src/views/ScheduleEditorView.vue` — template, script, and scoped styles.

The file has already grown large but is the accepted pattern in this project (edit-mode form is
tightly bound to view-mode DOM sharing `.sched` container). Do NOT extract sub-components in this
plan; that's a follow-up refactor.

Two more files touched only by the release commit:

* `apps/web/package.json` — version bump.
* `apps/web/CHANGELOG.md` — release entry promotion.

---

## Preflight

Before starting Task 1, confirm the branch state:

```bash
cd ~/Code/verse-vault
git status
git log --oneline -5
```

Expected: working tree clean; latest commit is the passage-picker-redesign spec
(`de5cdf2 docs: passage picker redesign spec`). If not, resolve before proceeding.

---

### Task 1: Aggregation helpers on the script side

Add the week-level count + per-passage pill helpers the new summary needs, and mark the per-block
ones for removal. This is script-only — no template change yet — so the file still compiles and the
existing summary keeps working.

**Files:**

* Modify: `apps/web/src/views/ScheduleEditorView.vue` (script setup block, near existing
  `cumulativeCount` around lines 260–290)

**Interfaces:**

* Consumes: `derivedVerseNumbers(block, 150 | 300)` (existing),
  `Schedule.weeks[i].blocks[j].passage`.
* Produces:
  * `weekClub150Count(week: ScheduleWeek): number` — sum of `derivedVerseNumbers(b, 150).length`
    across `week.blocks`.
  * `weekClub300Count(week: ScheduleWeek): number` — sum of `|c150 ∪ c300|` per block.
  * `weekFullCount(week: ScheduleWeek): number` — sum of `passage.endVerse − passage.startVerse + 1`
    per block (0 when passage isn't set).
  * `perBlockTierPills(week: ScheduleWeek, tier: 150 | 300): { blockIdx: number; passage: SchedulePassage; verses: number[] }[]`
    — one entry per block that has a non-empty tier list, in block order. Consumers use this for the
    multi-passage grouped display.

* [ ] **Step 1: Add the four helpers**

In `apps/web/src/views/ScheduleEditorView.vue`, immediately after the existing
`cumulativeCount(block, tier)` function, add:

```ts
/** Week-level cumulative memorize-scope counts. 150 = |c150| across
 *  every block; 300 = |c150 ∪ c300| per block, summed (verses are
 *  never shared across blocks — different passages, non-overlapping
 *  numeric ranges); Full = sum of every block's passage size. */
function weekClub150Count(week: ScheduleWeek): number {
  let n = 0
  for (const b of week.blocks) n += derivedVerseNumbers(b, 150).length
  return n
}

function weekClub300Count(week: ScheduleWeek): number {
  let n = 0
  for (const b of week.blocks) {
    const union = new Set<number>([
      ...derivedVerseNumbers(b, 150),
      ...derivedVerseNumbers(b, 300),
    ])
    n += union.size
  }
  return n
}

function weekFullCount(week: ScheduleWeek): number {
  let n = 0
  for (const b of week.blocks) {
    const { startVerse, endVerse } = b.passage
    if (startVerse >= 1 && endVerse >= startVerse) n += endVerse - startVerse + 1
  }
  return n
}

/** One entry per block whose `tier` list is non-empty, in block order.
 *  Powers the multi-passage grouped display in the week summary. */
function perBlockTierPills(
  week: ScheduleWeek,
  tier: 150 | 300,
): { blockIdx: number; passage: SchedulePassage; verses: number[] }[] {
  const out: { blockIdx: number; passage: SchedulePassage; verses: number[] }[] = []
  week.blocks.forEach((b, blockIdx) => {
    const verses = derivedVerseNumbers(b, tier)
    if (verses.length > 0) out.push({ blockIdx, passage: b.passage, verses })
  })
  return out
}
```

* [ ] **Step 2: Verify type-check passes**

Run: `pnpm --filter @verse-vault/web type-check`

Expected: same 10-error baseline as before, no new errors. The helpers are unused so far, so no
template errors either. If any new error surfaces, it's almost certainly a missing import or a stray
typo — fix in the same file before proceeding.

* [ ] **Step 3: Commit**

```bash
git add apps/web/src/views/ScheduleEditorView.vue
git commit -m "feat(web): aggregate week-level club helpers"
```

Body:

```
Adds weekClub150Count / weekClub300Count / weekFullCount helpers and
perBlockTierPills for the multi-passage grouped summary that lands
in the next commit. Helpers are unused for now; the template rewrite
comes next. No behaviour change.
```

---

### Task 2: Inline passage picker row

Replace the four-field grid inside every `<fieldset class="passage">` with a single flex row. Legacy
fallback (empty projection) stays as an untouched sibling branch. Block-level chrome (fieldset +
legend) is intentionally left for Task 3 so this task remains focused.

**Files:**

* Modify: `apps/web/src/views/ScheduleEditorView.vue` (template around lines 1080–1220 covering the
  passage fieldset, and scoped-style block around lines 2180–2260)

**Interfaces:**

* Consumes: `updateBlockPassage`, `updateBlockPassageField`, `materialBooks`, `chaptersFor`,
  `versesFor` (existing).
* Produces: no new script exports. Only DOM restructure.

* [ ] **Step 1: Replace the fieldset body's inner grid with a `.passage-row` flex row**

In `apps/web/src/views/ScheduleEditorView.vue`, find the
`<template v-if="materialBooks.length > 0">` branch inside each `<fieldset class="passage">`.
Replace its four `<label class="field passage-*">` children with:

```vue
<div class="passage-row">
  <label class="passage-field passage-field-book">
    <span>Book</span>
    <select
      :value="block.passage.book"
      @change="updateBlockPassage(bi, { book: ($event.target as HTMLSelectElement).value })"
    >
      <option value="">— select —</option>
      <option v-for="b in materialBooks" :key="b" :value="b">{{ b }}</option>
    </select>
  </label>
  <label class="passage-field passage-field-chapter">
    <span>Ch.</span>
    <select
      :value="block.passage.chapter || ''"
      :disabled="!block.passage.book"
      @change="updateBlockPassage(bi, { chapter: Number(($event.target as HTMLSelectElement).value) || 0 })"
    >
      <option value="">—</option>
      <option v-for="c in chaptersFor(block.passage.book)" :key="c" :value="c">{{ c }}</option>
    </select>
  </label>
  <label class="passage-field passage-field-start">
    <span>Start</span>
    <select
      :value="block.passage.startVerse || ''"
      :disabled="!block.passage.chapter"
      @change="updateBlockPassage(bi, { startVerse: Number(($event.target as HTMLSelectElement).value) || 0 })"
    >
      <option value="">—</option>
      <option
        v-for="v in versesFor(block.passage.book, block.passage.chapter)"
        :key="v"
        :value="v"
      >{{ v }}</option>
    </select>
  </label>
  <span class="passage-dash" aria-hidden="true">—</span>
  <label class="passage-field passage-field-end">
    <span>End</span>
    <select
      :value="block.passage.endVerse || ''"
      :disabled="!block.passage.startVerse"
      @change="updateBlockPassage(bi, { endVerse: Number(($event.target as HTMLSelectElement).value) || 0 })"
    >
      <option value="">—</option>
      <option
        v-for="v in versesFor(block.passage.book, block.passage.chapter).filter((n) => n >= block.passage.startVerse)"
        :key="v"
        :value="v"
      >{{ v }}</option>
    </select>
  </label>
</div>
```

Leave the `<template v-else>` legacy 4-input grid untouched.

* [ ] **Step 2: Add scoped styles for `.passage-row`**

At the bottom of the `<style scoped>` block (near the existing `.field select` rule), add:

```css
.passage-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.5rem 0.5rem;
}

.passage-field {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
  font-size: 0.85rem;
}

.passage-field > span {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-muted);
}

.passage-field select {
  padding: 0.3rem 0.5rem;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.85rem;
}

.passage-field select:disabled {
  color: var(--color-muted);
  cursor: not-allowed;
}

.passage-field-book {
  flex: 1 1 12rem;
}

.passage-field-chapter,
.passage-field-start,
.passage-field-end {
  flex: 0 0 auto;
}

.passage-field-chapter select,
.passage-field-start select,
.passage-field-end select {
  min-width: 3.5rem;
}

.passage-dash {
  align-self: flex-end;
  padding: 0 0.15rem 0.35rem;
  color: var(--color-muted);
  font-size: 0.85rem;
}

@container (max-width: 519px) {
  .passage-field-book {
    flex: 0 0 100%;
  }
}
```

* [ ] **Step 3: Verify type-check + browser render**

Run: `pnpm --filter @verse-vault/web type-check`

Expected: 10-error baseline unchanged.

Open the schedule editor in the browser (`pnpm dev:all`, log in, `/schedule/nkjv-cor`, click Edit,
click any week). Confirm:

* Book / Ch. / Start dropdowns sit on one line at desktop width, with the em-dash between Start and
  End.
* Book wraps to its own line when the container width drops below 520px.
* Cascade + auto-fill still work (change Book → chapter clears; change Chapter → Start/End auto-fill
  to full chapter).

* [ ] **Step 4: Commit**

```bash
git add apps/web/src/views/ScheduleEditorView.vue
git commit -m "feat(web): inline horizontal passage picker"
```

Body:

```
Replaces the four-field grid inside every passage fieldset with a
single flex row reading "Book | Ch. — Start — End". Caption labels
are short + muted; the em-dash between Start and End is aria-hidden
decoration. Wraps at container widths below 520px (Book on its own
row). Legacy 4-input grid fallback stays for the empty-projection
case (dev without content pipeline).
```

---

### Task 3: Drop block chrome; hairline between multi-passage blocks

Remove the fieldset + `PASSAGE` legend. Solo-block weeks show the picker row bare. Multi-block weeks
stack blocks with a `Passage N` caption + `× remove` on every block and a hairline `border-top`
between siblings.

**Files:**

* Modify: `apps/web/src/views/ScheduleEditorView.vue` (template around the fieldset opening tag
  through `</fieldset>`, plus a scoped-style block near the passage row rules)

**Interfaces:**

* Consumes: `removeBlock(blockIdx)` (existing).
* Produces: no new script exports.

* [ ] **Step 1: Replace the `<fieldset>` wrapper with `<div class="passage-block">`**

In `apps/web/src/views/ScheduleEditorView.vue`, replace the opening `<fieldset class="passage">` and
its `<legend>` block with:

```vue
<div class="passage-block" :class="{ 'has-siblings': row.week.blocks.length > 1 }">
  <div
    v-if="row.week.blocks.length > 1"
    class="passage-block-heading"
  >
    <span class="passage-block-index">Passage {{ bi + 1 }}</span>
    <button
      type="button"
      class="mini-danger"
      aria-label="Remove this passage"
      @click="removeBlock(bi)"
    >
      ×
    </button>
  </div>
```

Close the wrapper with `</div>` where the `</fieldset>` used to close (the block includes both the
picker row from Task 2 and the leftover verse-summary rows, which Task 4 removes — leave the current
summary rendering alone for this task).

* [ ] **Step 2: Add scoped styles for `.passage-block`**

Immediately after the `.passage-row` styles from Task 2, add:

```css
.passage-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.passage-block.has-siblings + .passage-block.has-siblings {
  padding-top: 0.75rem;
  border-top: 1px solid var(--color-border);
  margin-top: 0.75rem;
}

.passage-block-heading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--color-muted);
}

.passage-block-index {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
```

* [ ] **Step 3: Delete the now-unused fieldset styles**

Search the `<style scoped>` block for a rule matching `fieldset.passage,` — this is part of a
multi-selector rule shared with `fieldset.verses` / `fieldset.meet-fields`. Remove
`fieldset.passage,` from that comma list and, if it becomes a single-selector rule, keep the
remaining selectors as-is.

* [ ] **Step 4: Verify browser render**

Manual check at `/schedule/nkjv-cor` in edit mode:

* Single-passage week: picker row appears without a `PASSAGE` legend or bordered box; layout is
  tight.
* Multi-passage week (e.g. 2025-09-29 in the SK Corinthians schedule): each block shows `Passage 1`
  / `Passage 2` caption + `× remove`; blocks are separated by a hairline rule.
* Removing a block from a two-block week collapses it into a single-passage row with no heading or
  hairline.

* [ ] **Step 5: Commit**

```bash
git add apps/web/src/views/ScheduleEditorView.vue
git commit -m "feat(web): drop passage-block chrome"
```

Body:

```
Removes the fieldset + PASSAGE legend from every passage block.
Solo blocks render bare (just the picker row); multi-passage weeks
stack blocks with a small Passage-N caption + × remove and a
hairline border-top between siblings. Chrome is lighter without
losing block boundaries where they matter.
```

---

### Task 4: Week-level club summary; drop per-block summary

Move the club summary out of every block and into the wk-form as a single week-level block using the
helpers from Task 1. Single-passage weeks keep the existing count + pill layout; multi-passage weeks
nest a per-passage sub-row per club.

**Files:**

* Modify: `apps/web/src/views/ScheduleEditorView.vue` (delete the existing
  `<div class="verses-summary">` from inside each block; add a new week-level summary right below
  the last block; add / adjust CSS for the new nested rows)

**Interfaces:**

* Consumes: `weekClub150Count`, `weekClub300Count`, `weekFullCount`, `perBlockTierPills`,
  `derivedVerseNumbers` (existing / from Task 1).
* Produces: no new script exports.

* [ ] **Step 1: Delete the per-block `<div class="verses-summary">` block**

Search the template for `class="verses-summary"`. Remove the entire
`<div class="verses-summary" aria-label="Verse numbers">` … `</div>` from inside the picker
`<template v-if="!row.week.isReview">` iteration. Leave nothing where it was.

* [ ] **Step 2: Insert the week-level summary after the block loop**

Locate the closing `</template>` of the `v-for="(block, bi) in row.week.blocks"` loop. Immediately
after the `<button ... @click="addPassageBlock">` add-a-passage button, insert:

```vue
<div v-if="row.week.blocks.length > 0" class="week-summary" aria-label="Week verse summary">
  <div class="week-summary-row">
    <span class="week-summary-label club-150">
      150 · {{ weekClub150Count(row.week) }}
    </span>
    <div class="week-summary-vals">
      <template v-if="row.week.blocks.length === 1">
        <span
          v-for="n in derivedVerseNumbers(row.week.blocks[0]!, 150)"
          :key="n"
          class="v v-150"
        >{{ n }}</span>
        <span
          v-if="!derivedVerseNumbers(row.week.blocks[0]!, 150).length"
          class="verses-empty"
        >—</span>
      </template>
      <template v-else>
        <div
          v-for="group in perBlockTierPills(row.week, 150)"
          :key="`c150-${group.blockIdx}`"
          class="week-summary-passage"
        >
          <span class="passage-prefix">Ch {{ group.passage.chapter }}:</span>
          <span
            v-for="n in group.verses"
            :key="`c150-${group.blockIdx}-${n}`"
            class="v v-150"
          >{{ n }}</span>
        </div>
      </template>
    </div>
  </div>
  <div class="week-summary-row">
    <span class="week-summary-label club-300">
      300 · {{ weekClub300Count(row.week) }}
    </span>
    <div class="week-summary-vals">
      <template v-if="row.week.blocks.length === 1">
        <span
          v-for="n in derivedVerseNumbers(row.week.blocks[0]!, 300)"
          :key="n"
          class="v v-300"
        >{{ n }}</span>
        <span
          v-if="!derivedVerseNumbers(row.week.blocks[0]!, 300).length"
          class="verses-empty"
        >—</span>
      </template>
      <template v-else>
        <div
          v-for="group in perBlockTierPills(row.week, 300)"
          :key="`c300-${group.blockIdx}`"
          class="week-summary-passage"
        >
          <span class="passage-prefix">Ch {{ group.passage.chapter }}:</span>
          <span
            v-for="n in group.verses"
            :key="`c300-${group.blockIdx}-${n}`"
            class="v v-300"
          >{{ n }}</span>
        </div>
      </template>
    </div>
  </div>
  <div class="week-summary-row week-summary-row-full">
    <span class="week-summary-label club-full">
      Full · {{ weekFullCount(row.week) }}
    </span>
  </div>
</div>
```

* [ ] **Step 3: Add scoped styles for `.week-summary`**

Immediately after the `.passage-block` styles from Task 3, add:

```css
.week-summary {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.6rem 0.8rem;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  margin-top: 0.75rem;
}

.week-summary-row {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  flex-wrap: wrap;
}

.week-summary-label {
  flex: 0 0 5rem;
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.week-summary-label.club-150 {
  color: var(--color-grade-hard);
}

.week-summary-label.club-300 {
  color: var(--color-grade-easy);
}

.week-summary-label.club-full {
  color: var(--color-muted);
}

.week-summary-vals {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  flex: 1 1 auto;
}

.week-summary-passage {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: baseline;
}

.passage-prefix {
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.72rem;
  color: var(--color-muted);
  flex: 0 0 auto;
}

.week-summary .v {
  font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem;
  padding: 0.1rem 0.4rem;
  border-radius: 5px;
  line-height: 1.25;
}

.week-summary .v-150 {
  background: var(--color-grade-hard-bg);
  color: var(--color-grade-hard);
}

.week-summary .v-300 {
  background: var(--color-grade-easy-bg);
  color: var(--color-grade-easy);
}
```

* [ ] **Step 4: Remove now-unused per-block summary CSS**

Search the `<style scoped>` block for these class rules — the block-level `.verses-summary`,
`.verses-row`, `.verses-label`, `.verses-vals`, and `.verses-vals .v-*` — and delete them (they were
used only by the per-block summary the template no longer renders).

Keep `.verses-empty` (still used by the single-passage flat pill list under `.week-summary-vals`).

* [ ] **Step 5: Verify browser render**

Manual check:

* Single-passage week (e.g. 2025-09-08): summary shows `150 · N`, `300 · N`, `Full · N` rows with
  flat pill lists. Colours match spec (150 warm, 300 blue).
* Multi-passage week (2025-09-29 in Corinthians): summary shows one row per club with `Ch 4:` /
  `Ch 5:` sub-rows containing that passage's pills. Counts are the cumulative totals across both
  blocks.

* [ ] **Step 6: Commit**

```bash
git add apps/web/src/views/ScheduleEditorView.vue
git commit -m "feat(web): single week-level club summary"
```

Body:

```
Moves the club-verse summary out of every block and into a single
row at the bottom of the wk-form. Single-passage weeks render as
before (bare pill list). Multi-passage weeks nest a sub-row per
passage under each club label with a `Ch N:` prefix, so a user asking
"what does the 300 kid memorise this week?" reads it directly. Counts
stay cumulative (150 = |c150|, 300 = |c150 ∪ c300|, Full = passage
size sum), aggregated across every block.
```

---

### Task 5: Derived review state — drop the Review checkbox

Delete the `<label class="toggle">` review-checkbox. Removing the last block auto-flags the week as
review; adding a block to a review week auto-clears the flag. Both flows already work through
`addPassageBlock` / `removeBlock`; this task wires them to the `isReview` field and adds the
review-week empty-state UI.

**Files:**

* Modify: `apps/web/src/views/ScheduleEditorView.vue` (template around the review checkbox and the
  `v-if="!row.week.isReview"` gate, plus `addPassageBlock`, `removeBlock`, and `toggleReviewWeek` in
  the script)

**Interfaces:**

* Consumes: existing draft mutation pattern (`draft.value.weeks[idx] = { ...week, ... }`).
* Produces: no new exports.

* [ ] **Step 1: Delete the Review checkbox label**

In the template inside the wk-form, find:

```vue
<label class="toggle">
  <input
    type="checkbox"
    :checked="row.week.isReview"
    @change="toggleReviewWeek"
  />
  <span>Review week (no new verses introduced)</span>
</label>
```

Delete the entire `<label>`.

* [ ] **Step 2: Replace `v-if="!row.week.isReview"` with an
      `<template v-if="row.week.blocks.length > 0">` around the picker + summary; add a review-week
      empty-state block**

Locate the current outer gate `<template v-if="!row.week.isReview">` in the wk-form and rename its
condition:

```vue
<template v-if="row.week.blocks.length > 0">
```

Immediately after that `<template>`'s closing tag (before the form-actions row), add the
review-state message:

```vue
<template v-else>
  <p class="review-empty">
    This is a review week — no verses introduced.
  </p>
  <button
    type="button"
    class="add-block"
    @click="addPassageBlock"
  >
    + Add a passage
  </button>
</template>
```

* [ ] **Step 3: Update `addPassageBlock` to clear `isReview`**

Find `function addPassageBlock()`. Replace its final line (the `draft.value.weeks[idx] = ...`
assignment) with a version that flips `isReview: false`:

```ts
draft.value.weeks[idx] = {
  ...week,
  isReview: false,
  blocks: [...week.blocks, newBlock],
}
```

* [ ] **Step 4: Update `removeBlock` to set `isReview: true` when the last block goes**

Find `function removeBlock(blockIdx: number)`. Replace its body with:

```ts
function removeBlock(blockIdx: number) {
  if (draft.value === null || selection.value?.kind !== 'week') return
  const idx = selection.value.weekIdx
  const week = draft.value.weeks[idx]
  if (!week) return
  const nextBlocks = week.blocks.filter((_, i) => i !== blockIdx)
  draft.value.weeks[idx] = {
    ...week,
    isReview: nextBlocks.length === 0,
    blocks: nextBlocks,
  }
}
```

Note: the previous `week.blocks.length <= 1` guard is removed — the whole point is that removing the
last block IS the "make this a review week" action.

* [ ] **Step 5: Delete `toggleReviewWeek`**

Search for `function toggleReviewWeek(`. Delete the entire function (about 20 lines) — it's no
longer referenced.

* [ ] **Step 6: Update the `Passage N × remove` heading condition**

The heading currently renders only when `row.week.blocks.length > 1`. That was because the sole
block couldn't be removed. Now it can. Change the condition on the `.passage-block-heading`
`<div v-if="…">` from:

```vue
<div v-if="row.week.blocks.length > 1" class="passage-block-heading">
```

to:

```vue
<div v-if="row.week.blocks.length > 1 || row.week.blocks.length === 1" class="passage-block-heading">
```

Wait — that's every block. Prefer the simpler:

```vue
<div class="passage-block-heading">
```

… with `Passage {{ bi + 1 }}` only shown when multi-block:

```vue
<div class="passage-block-heading">
  <span
    v-if="row.week.blocks.length > 1"
    class="passage-block-index"
  >Passage {{ bi + 1 }}</span>
  <button
    type="button"
    class="mini-danger"
    aria-label="Remove this passage"
    @click="removeBlock(bi)"
  >
    ×
  </button>
</div>
```

That way the `× remove` button is always present (so the sole block can also be removed → review
week), but the "Passage N" caption only shows when there are siblings to distinguish.

* [ ] **Step 7: Add scoped styles for `.review-empty`**

Immediately after `.week-summary` rules, add:

```css
.review-empty {
  margin: 0;
  padding: 0.9rem 1rem;
  background: var(--color-bg);
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  color: var(--color-muted);
  font-style: italic;
  text-align: center;
}
```

* [ ] **Step 8: Verify browser render**

Manual check:

* Editing a normal week: no Review checkbox visible. `×` remove sits at every block.
* Removing the sole passage from a normal week: the wk-form collapses to the italic dashed "This is
  a review week" message + `+ Add a passage`. Save the schedule → reload → week persists as review
  (`isReview: true`).
* On a bundled review week (e.g. 2025-11-17 in Corinthians): open the week in edit mode, click
  `+ Add a passage`. Fresh single-block picker appears with the smart next-passage default. The week
  is no longer review.

* [ ] **Step 9: Commit**

```bash
git add apps/web/src/views/ScheduleEditorView.vue
git commit -m "feat(web): derive review state from blocks"
```

Body:

```
Removes the Review checkbox from the wk-form. Review is now
emergent: week.blocks.length === 0 → review week. Removing the
last block from a normal week auto-flags isReview; adding the
first block to a review week clears it. The Passage-N caption
still only appears on multi-block weeks, but the × remove button
now lives on every block (including the sole one) so the "make
this a review week" action is one click. Wire form unchanged —
week.isReview still ships on every week, just derived from
blocks now.
```

---

### Task 6: Release web 0.9.0

Version-bump + CHANGELOG promotion following the pre-commit hook's contract-versions check.

**Files:**

* Modify: `apps/web/package.json`
* Modify: `apps/web/CHANGELOG.md`

**Interfaces:** none.

* [ ] **Step 1: Bump `apps/web/package.json` version**

Change `"version": "0.8.1"` to `"version": "0.9.0"`.

* [ ] **Step 2: Promote `[Unreleased]` in the web CHANGELOG**

At the top of `apps/web/CHANGELOG.md`, add a new dated section directly below the `## [Unreleased]`
header:

```markdown
## [0.9.0] — 2026-07-13

Passage picker redesign (spec `docs/superpowers/specs/2026-07-13-passage-picker-redesign.md`). MINOR
— visible UX change on `/schedule/:materialId` edit mode; no wire-format change.

### Bundled algorithm contract

* `verse-vault-core@0.7.0` — unchanged.
* `verse-vault-wasm@0.7.0` — unchanged.

### Editor

* Passage editor: four labelled dropdowns → one inline horizontal row reading
  `Book | Ch. | Start — End`. Wraps at container widths below 520px (Book on its own row).
* Multi-passage weeks: fieldset border + PASSAGE legend gone; blocks stack with a small `Passage N`
  caption + `× remove` and a hairline `border-top` between siblings. Solo blocks render bare.
* Club summary: moved out of every block into a single week-level row below all blocks. Single-
  passage weeks keep the flat pill list; multi-passage weeks nest a `Ch N:` sub-row per passage
  under each club label. Counts stay cumulative (150 / 300 / Full).
* Review-week toggle removed. Review is now derived: `blocks.length === 0`. Removing the sole
  passage collapses the wk-form to an italic dashed "This is a review week" message +
  `+ Add a passage` button; adding a passage clears the state.
```

* [ ] **Step 3: Confirm the contract-versions hook passes**

Run: `bash tools/check-contract-versions.sh`

Expected: no output (exit 0). If it fails, re-read the `## [0.9.0] — 2026-07-13` heading — the check
requires the `## [X.Y.Z]` section AND requires the bundled-contract subsection to reference
`verse-vault-core@0.7.0` and `verse-vault-wasm@0.7.0` (both unchanged in this release, per §3 of the
spec).

* [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/CHANGELOG.md
git commit -m "chore(web): release 0.9.0"
```

Body:

```
Passage picker redesign. Contract crates unchanged.
```

---

### Task 7: Verification pass

**Files:** none (verification only).

* [ ] **Step 1: Full web type-check**

Run: `pnpm --filter @verse-vault/web type-check`

Expected: same 10-error baseline as before this train started; no new errors introduced by any task.

* [ ] **Step 2: Full API test-suite** (belt-and-braces — no API code changed)

Run: `pnpm --filter @verse-vault/api test`

Expected: PASS (currently ~205 tests). If any fail, it means either a) API state seeped in somewhere
it shouldn't have, or b) a pre-existing flake. Investigate before pushing.

* [ ] **Step 3: Contract-versions gate**

Run: `bash tools/check-contract-versions.sh` Run: `bash tools/check-contract-versions.sh --ci web`

Expected: both exit 0, second prints `[0.9.0] references core@0.7.0, wasm@0.7.0… OK.`

* [ ] **Step 4: Manual smoke — every acceptance criterion from §5 of the spec**

`pnpm dev:all`, log in, navigate to `/schedule/nkjv-cor`, click Edit, and step through:

* Single-passage week (2025-09-08): picker row on one line ≥ 520px, two lines < 520px. No fieldset
  border. Single summary below.
* Multi-passage week (2025-09-29): two picker rows separated by hairline, each with `Passage N` /
  `× remove`. Single summary below with per-passage sub-rows.
* Review week (2025-11-17): no picker rows, `+ Add a passage` visible, no summary.
* Remove the sole block from any non-review week → collapses to the empty state.
* Add a passage to a review week → picker with smart next-passage default; summary re-appears.

Also spot-check on `/schedule/nkjv-nt` — that deck has seven compound weeks and different books,
exercises the multi-passage grouping thoroughly.

* [ ] **Step 5: Push**

```bash
git push
```

The remote already tracks this branch (`fix/schedule-clone-reactive-proxy`). PR #102 stays in draft;
no PR state change here.

---

## Self-Review

**Spec coverage:**

* §2.1 Inline passage picker → Task 2. ✓
* §2.2 Block chrome (no border, hairline, Passage-N caption + × remove) → Task 3 and finalised in
  Task 5 Step 6. ✓
* §2.3 Week-level club summary (flat single-passage, grouped multi-passage) → Task 1 (helpers) +
  Task 4 (template + styles). ✓
* §2.4 Review-week semantics from `blocks.length` → Task 5. ✓
* §3 Non-goals — wire format untouched (verified in Task 6's contract check step); no new tokens
  (all styles use existing `--color-*` tokens); accessibility (labels bound, em-dash `aria-hidden`,
  tab order) — encoded in Task 2/3 template markup. ✓
* §4 Files touched — only `apps/web/src/views/ScheduleEditorView.vue` (Tasks 1–5), plus
  `apps/web/package.json` + `apps/web/CHANGELOG.md` (Task 6). ✓
* §5 Acceptance — Task 7 Step 4 walks through every bullet. ✓

**Placeholder scan:** none. Every step carries code or exact commands.

**Type consistency:** `weekClub150Count` / `weekClub300Count` / `weekFullCount` /
`perBlockTierPills` are defined once in Task 1 and used verbatim in Task 4. `SchedulePassage`,
`ScheduleWeek`, `PassageBlock` are the existing web types from `apps/web/src/lib/schedule.ts` — no
renames.
