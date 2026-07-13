# Passage picker redesign — schedule editor

> **Follow-up to** `2026-06-23-schedule-editor-redesign.md`. That doc defined the editor's macro
> layout (responsive `.sched` with expand-in-place forms). This one addresses one component inside
> that form — the per-passage editor and the per-week club summary — after the initial
> implementation shipped and read as bulky.

## 1. Problem

The current per-week edit form renders one bordered fieldset per passage block with four labelled
dropdowns (Book / Chapter / Start verse / End verse) stacked vertically, then a separate summary
block per passage listing 150 / 300 / Full counts and pill lists. On multi-passage weeks the whole
form is a stack of thick bordered boxes; on single-passage weeks the fieldset chrome dominates a
form whose content is one line of reference text. The Review-week toggle is a third control that
only ever means "no passages this week."

Three concrete symptoms:

* The four picker fields don't read as a single passage. The visual grouping (fieldset border + bold
  `PASSAGE` legend) implies structure the reference doesn't have — `1 Corinthians 2:1–16` is one
  reference, not four fields.
* Density. Each dropdown is 0.35 × 0.55rem padding at 0.9rem font; combined with the fieldset
  border + legend + vertical stack, a single passage takes ~180px of vertical space.
* Multi-passage summaries duplicate the club-row layout per passage. A user asking "what does the
  club-300 kid memorise this week?" has to add across passages themselves.

## 2. Redesign — three parts

### 2.1 Inline passage picker

Replace the four-field grid with a horizontal row that reads like the printed reference. Above each
dropdown sits a short caption label; below, an em-dash separator sits between Start and End.

Wide (≥ 520px container width):

```
Book                       Ch.    Start    End
[ 1 Corinthians       ⌄ ]  [2 ⌄]  [1 ⌄] — [16 ⌄]
```

Narrow (< 520px):

```
Book
[ 1 Corinthians ⌄ ]

Ch.    Start    End
[2 ⌄]  [1 ⌄] — [16 ⌄]
```

Layout mechanics (all inside the existing `.wk-form` container query):

* Row is a flex container with `flex-wrap: wrap`. Book grows via `flex: 1 1 12rem`; Ch. / Start /
  End are `flex: 0 0 auto` with `min-width` sized to their widest expected content.
* Caption labels: `0.68rem` uppercase, `letter-spacing: 0.06em`, `color: var(--color-muted)`,
  `margin: 0`.
* Dropdowns: `0.3rem 0.5rem` padding, `0.85rem` font, existing border + focus styles.
* Between fields horizontal gap: `0.5rem`. The em-dash between Start and End renders as a plain text
  node with `padding: 0 0.15rem` and `color: var(--color-muted)`.

Behaviour is unchanged from today's cascade: Book change resets chapter + verses; Chapter change
resets verses; Start bumping past End lifts End along. Fallback to the legacy 4-input grid stays in
place for the dev-without-content-pipeline case (empty `materialPassages`).

### 2.2 Block chrome — no boxes, hairline between blocks

Drop the fieldset + `PASSAGE` legend entirely. Per-block visual chrome for the common single-passage
week is nothing: the picker row sits directly in the form.

Multi-passage weeks stack blocks with a thin hairline between them:

```
Passage 1
[ picker row(s) ]

──────────────────────────────  (1px var(--color-border))

Passage 2                   [× remove]
[ picker row(s) ]

──────────────────────────────

[ + Add a passage ]
```

* Heading (`Passage 1` / `Passage 2`) is small caption text (`0.7rem` uppercase, muted), rendered
  only when the week has ≥ 2 blocks.
* The `×` remove button sits inline with the heading. Applies to every block, including the first —
  removing the last block is the "make this a review week" affordance (§2.4).
* Hairline is a `border-top` on the second-and-later block containers, only when the week has ≥ 2
  blocks.
* Solo blocks render bare — no heading, no hairline, no border.

### 2.3 Week-level club summary

Replace per-block summaries with a single week-level summary sitting below the last block:

Single-passage week (unchanged appearance from today, just relocated):

```
150 · 5     [5]  [10]  [17]  [18]  [21]
300 · 4     [2]  [3]   [6]   [7]
Full · 22
```

Multi-passage week, grouped by passage:

```
150 · 12
  Ch 2:   [5]  [10]  [14]
  Ch 3:   [6]  [11]  [16]  [20]  [24]
  Ch 4:   [1]  [7]

300 · 8
  Ch 2:   [3]  [4]  [15]
  Ch 3:   [7]  [8]  [12]  [18]  [21]

Full · 47
```

Counts stay cumulative per the Bible-quiz convention (`150 = |c150|`, `300 = |c150 ∪ c300|`,
`Full = sum of passage sizes`), aggregated across every block:

* `club150Count(week)` = sum of `derivedClub150(block).length` across `week.blocks`
* `club300Count(week)` = sum of `|club150 ∪ club300|` per block
* `fullCount(week)` = sum of `passage.endVerse − passage.startVerse + 1` per block

Pills for 150 / 300:

* Single-passage weeks: bare pill list (no `Ch N:` prefix).
* Multi-passage weeks: sub-row per passage, indented, with `Ch N:` prefix and the pills belonging to
  that passage. Sub-rows omit passages whose tier list is empty.

Full stays count-only in both cases — a Full kid memorises the whole passage(s), so listing every
verse is noise.

Same colour tokens as today (`--color-grade-hard` for 150, `--color-grade-easy` for 300, muted for
Full).

### 2.4 Review-week semantics — derived from `blocks.length`

Drop the Review checkbox from the form. Review is an emergent state:

* `week.blocks.length === 0` → review week. Wire form still carries `isReview: true` for
  backward-compat with existing schedule JSONs and the API validator; the UI just doesn't expose it
  as a user-editable toggle.
* Removing the last block from a non-review week auto-writes `isReview: true` and clears any stored
  passage state.
* Adding a first passage to a review week auto-writes `isReview: false`.

Review-week form:

```
This is a review week — no verses introduced.

[ + Add a passage ]
```

No picker rows, no summary. The `Remove this week` affordance stays gone (§10 of the parent spec:
edges only, via the range editor).

## 3. Non-goals

* No wire-format change. `PassageBlock` still carries `passage` + `verses`; `week.isReview` still
  ships on every week. Server-side derivation of `verses` (phase B of the derivation plan) stays a
  separate change.
* No new colour tokens or icons.
* No accessibility regressions: caption labels are `<label for="…">` bound to their `<select>`s; the
  em-dash separator carries `aria-hidden="true"`; every dropdown still tabs in order.

## 4. Files touched

* `apps/web/src/views/ScheduleEditorView.vue`
  * Template: passage fieldset → inline row; per-block summary → week-level summary; Review checkbox
    → derived state.
  * Script: aggregation helpers (`club150Count(week)`, `club300Count(week)`, `fullCount(week)`,
    per-passage pill list); `addPassageBlock` / `removeBlock` un-mark review; `toggleReviewWeek`
    goes away.
  * Styles: passage-picker row + labels; block hairline; week summary layout.

## 5. Acceptance

* Single-passage week: picker row on one line at ≥ 520px, two lines at < 520px. No fieldset border.
  One week-level summary below.
* Multi-passage week: two picker rows separated by a thin hairline, each with `Passage N` /
  `× remove` heading. Single summary below aggregating both passages, grouped by chapter.
* Review week: no picker rows, `+ Add a passage` visible, no summary.
* Removing the sole block from a non-review week yields a review week (empty state visible, no
  crash, no lost draft).
* Adding a passage to a review week populates a fresh single-passage picker with the smart
  next-passage default and re-shows the summary.
