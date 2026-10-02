# Research: Proofread Recitation Diff

Phase 0 decisions. The spec left no `NEEDS CLARIFICATION` markers; the visual design was settled in
mockups before specification, so the questions here are about where each piece lives and how the
layout requirements are met.

## R1. Where the diff becomes edits

**Decision**: A new pure module next to `wordDiff`, in `apps/web/src/lib/diff/`, owns everything
between the raw diff and presentation for prose cards: grouping consecutive non-match items into
edits (replace, add, skip), merging edits across short glue runs (FR-010), and computing the two
match measures that choose the wrong-verse fallback (FR-011).

**Rationale**: These are the decisions the spec makes testable, and every one of them is a pure
function of `DiffItem[]`. Keeping them out of the component lets vitest cover the seven reference
cases directly. The web suite has no component-testing setup (no `@vue/test-utils`, and
`vitest.config.ts` deliberately avoids the Vite config), so logic left in `CardPrompt.vue` would go
untested.

**Alternatives considered**:

* _Extend `wordDiff` itself._ Rejected: `wordDiff` decides which words match and is also the
  club-list engine, which must not merge or fall back. Its only change is the tie-break in R11.
* _Put the logic in `CardPrompt.vue`._ Rejected for testability, above.

## R2. Where the markup is produced

**Decision**: Keep producing the back's HTML in `CardPrompt.vue`'s existing `diffHtml` computed,
which the Recitation, Ftv, and ChapterClubList branches already share. It switches from mapping raw
diff items to mapping edits (prose) or ordered items (club list), and also produces the fallback
body. The enlarged diff type size goes on the proofread and club-list bodies that `diffHtml` emits,
not on the shared `verse-text diff` container, so the fallback's verse keeps the normal size.

**Rationale**: One computed, already wired into all three reveal branches, already next to
`escapeHtml`, `verseNumberSpan`, and the verse-colour helpers it needs. The templates need no
change, because the size difference between the proofread body and the fallback is carried inside
the markup `diffHtml` produces. Principle VII: reuse before adding a module.

**Alternatives considered**:

* _A new child component rendering edits with `v-for`._ Cleaner escaping, but it needs the
  verse-colour helpers that live inside `CardPrompt.vue`, which would mean moving them first, and it
  adds a module for markup the existing computed can produce. Rejected as more structure than the
  feature needs. Worth revisiting if `CardPrompt.vue` is split for other reasons.

## R3. Semantic elements for marks

**Decision**: Struck typed words render in `<del>`, correction labels in `<ins>`, and each mark
carries a `title` stating both sides ("You typed: do. Verse: to.").

**Rationale**: FR-016 asks that both sides be available without the visual layout. `<del>` and
`<ins>` carry that meaning natively, are exposed by assistive technology, and `<del>` strikes by
default. The `title` covers pointer users who want confirmation.

**Alternatives considered**: Visually hidden "you typed" text inside each mark. Rejected as more
markup restating what the elements already say.

## R4. Keeping labels from overlapping (FR-009)

**Decision**: Each replace or skip mark is an inline block in the normal flow, stacking the label on
top of the typed words (or caret), centred, with a maximum width of the line. An inline block's
baseline is its last line, so the bottom row sits on the sentence's baseline. The label wraps when
it is wider than the line, and a mark that does not fit the rest of a line starts on the next.

**Rationale**: Because the label is in the flow, it reserves its own width and height: it can never
overlap a neighbour or the line above, and a long label just makes its line taller. One form serves
every edit, so FR-006 needs no length limits or special cases, and the paragraph keeps a normal
line-height (R6). Pure CSS, no measurement. Checked in the mockups on all seven reference cases,
including the 15-word trailing skip and the merged John 1:14 phrase at phone width.

**Alternatives considered**:

* _A label absolutely positioned above a width-reserving inline grid._ The first approach. The label
  can't wrap, so long edits needed a separate inline form and a three-word, twenty-character limit,
  and the paragraph needed a line-height of 3 on every line to leave room. Dropped for the simpler
  in-flow stack.
* _CSS ruby._ Stretches the base text's spacing when the annotation is longer.
* _Measuring in JavaScript and padding._ Needs resize listeners and runs after paint.

## R5. Colours

**Decision**: One new token, `--color-mark-line`, in `apps/web/src/assets/colors.css`, for the
strikethrough line and the caret, with a light and a dark value (mockup values: light `#a59d92`,
dark `#a8a096`). Labels use `--active-verse-colour` for text and
`color-mix(in oklch, var(--active-verse-colour) 16%, var(--color-bg-card))` for their tint. Struck
words use `--color-text`. The existing `.diff-missing` and `.diff-extra` rules, and their use of
`--color-grade-again`, are removed.

**Rationale**: FR-007's rule ("coloured means verse") falls out of reusing `--active-verse-colour`,
which `.card-box` already sets per card and `verseNumberSpan` already sets per club number. Dark
values follow the file's existing `@media (prefers-color-scheme: dark)` block.

**Alternatives considered**: Reusing `--color-muted` for the line. Rejected: the mockup review found
it too dark against the dark card, and the line needs its own tuning.

## R6. Type size and spacing

**Decision**: The proofread and club-list bodies are 1.3rem with a line-height of 1.8; inside a
mark, a line-height of 1.3; labels are 0.95rem bold in the card face; the strikethrough is 1px. The
fallback and un-typed backs keep today's `.verse-text` sizing.

**Rationale**: Values signed off in the mockups. In-flow marks make their own room (R4), so lines
without marks keep ordinary spacing; an early mockup with a line-height of 3 left large gaps.

## R7. Club-list ordering

**Decision**: Club-list edits are shown per number, never paired into replacements, and within a run
of consecutive edits the numbers are put in ascending order. That ordering rule lives with the other
club-list answer rule in `apps/web/src/lib/diff/clubList.ts`. Tokens that are not numbers (input
`parseVerseList` rejected) render struck as typed.

**Rationale**: The LCS of two ascending lists already orders matches; only the order inside an edit
run is arbitrary, and a reader expects a sorted list (spec US5). Keeping it beside
`normaliseClubListAnswer` gives club-list answer handling one owner.

## R8. Thresholds as named values

**Decision**: The three thresholds (50% for each match measure, two glue words, four glue letters)
are named constants in the R1 module, each with a comment pointing at the spec requirement it
implements.

**Rationale**: The spec's Assumptions call them starting values open to tuning. Named constants keep
a future tune to a one-line change, and tests reference the behaviour, not the numbers.

## R9. Documentation

**Decision**: Add `docs/type-to-recite.md` describing the whole feature (optional typing, normalized
comparison, FTV prefix handling, the proofread view, fallback, merge, club lists), list it in
`CLAUDE.md`'s reference docs, and point the club-list mention in `docs/unspecced.md` at it.

**Rationale**: Principle I. The feature has shipped since web 0.1.14 with no doc, and this change
alters its documented-nowhere behaviour, so this is the moment to write it down.

## R10. Release

**Decision**: `@verse-vault/web` MINOR, labelled as such in its changelog, with the number set when
the bump commit is written. No contract crate changes.

**Rationale**: A visible change to how a feature behaves, in the same class as 0.9.16's typed club
lists, which was labelled MINOR. No Rust is touched, so Principle III does not apply.

## R11. Typed-side tie-break in `wordDiff`

**Decision**: In `wordDiff`'s traceback, when the current expected and typed tokens are equal, the
expected token cannot be skipped without shortening the match, but the typed token can, skip the
typed token as extra. The effect is to prefer the earliest typed occurrence, mirroring the existing
preference for the earliest expected occurrence (`b434286`).

**Rationale**: Typing John 1:10 followed by John 1:11 currently matches 1:10's final "Him." against
1:11's final "Him.", striking 1:10's real last word and splitting 1:11 around it. With the
tie-break, 1:10 matches in full and 1:11 is struck as one stretch. Checked against the mockup's
seven cases: the run-together case is fixed, five are unchanged, and the wrong-verse case changes
only which "He" matches, which the fallback hides. It is a defect in today's diff as well, so it
lands as its own commit ahead of the feature.

**Alternatives considered**: Leaving `wordDiff` alone and recording the defect. Rejected by the
user: the proofread view makes the split conspicuous.
