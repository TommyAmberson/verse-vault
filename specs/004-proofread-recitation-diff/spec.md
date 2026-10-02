# Feature Specification: Proofread Recitation Diff

**Feature Branch**: `feat/proofread-diff`

**Created**: 2026-10-02

**Status**: Draft

**Input**: Redesign the type-to-recite feedback shown on the back of a card. The current word diff
is hard to read: it is unclear what was missing versus extra, and where. Replace it with a
"proofread" view of what the reader typed, with corrections written above it in the verse colour,
fall back to the plain verse when the reader recited the wrong verse, and give club-list answers the
same look. Design settled through mockups (option "E" with merge, plus the club-list section).

## Context

Recitation, FTV, and chapter club-list cards take an optional typed answer. When the reader types
something and flips the card, the back replaces the verse with a word-level diff: matched words in
the verse colour, missed verse words underlined in red, and typed words that are not in the verse
struck through in the same red.

Readers find this hard to use, for five reasons:

* Missed and extra words share one colour, told apart only by underline versus strikethrough, and
  underline already means "keyword" on a normal card back.
* The correct verse never appears as continuous text. It is interleaved with the reader's own words,
  so a badly wrong attempt leaves nothing clean to read.
* Verse colours 1, 2, and 3 (and every verse number ending in those digits) are red, pink, and
  salmon, close to the error red, so correct words and error marks look alike.
* A single swapped word reads as two unrelated marks, the wrong word first.
* Reciting the wrong verse entirely produces a line of mostly struck-through noise.

What the existing feature deliberately chose, and this spec keeps: typing stays optional, the reader
still grades themselves 1 to 4, comparison ignores case and punctuation, and matched words keep the
verse colour. The underlying word comparison is unchanged apart from one tie-break fix (FR-014);
this feature changes how its result is presented.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Reader sees their attempt corrected like a proofread page (Priority: P1)

A quizzer types a recitation that is close but not exact and flips the card. The back shows what
they typed, in the order they typed it. Words they got right are in the verse colour. Each mistake
is struck through, with the verse's actual words written just above it in the verse colour. Words
they added are struck through. Where they skipped words, a small caret shows the spot, with the
skipped words above it.

**Why this priority**: Near-misses are the common case, and the reason the typed answer exists.
Seeing exactly which word went wrong, and what it should have been, in one glance, is the whole
value of typing instead of reciting aloud.

**Independent Test**: Type a recitation with one wrong word, one added word, and one skipped word,
flip, and confirm each appears in its own form with the correct words above the mistakes.

**Acceptance Scenarios**:

1. **Given** an FTV card for John 1:11 whose expected continuation is "to His own, and His own did
   not receive Him.", **When** the reader types "do His own, and His own did not receive Him." and
   flips, **Then** "do" appears struck through and uncoloured with "to" above it in the verse
   colour, and every other word appears in the verse colour unmarked.
2. **Given** a Recitation card for John 1:1, **When** the reader types "In the beginning was the
   Word and the Word was with the Lord, and the Word was God" and flips, **Then** "the Lord,"
   appears struck through with "God," above it, and the missing comma after the first "Word" is not
   marked.
3. **Given** any card with a typed answer, **When** the reader types words that are not in the verse
   at a point where nothing is missing, **Then** those words appear struck through with nothing
   above them.
4. **Given** any card with a typed answer, **When** the reader leaves out one to three words in the
   middle of the verse, **Then** a caret appears where they belong, with the missing words above it
   in the verse colour.
5. **Given** a card for a verse whose colour is red, pink, or salmon, **When** the reader's answer
   contains mistakes, **Then** the mistakes are visibly distinct from correct words, because no
   error mark uses the verse colour or any red.

---

### User Story 2 - Reader who recited the wrong verse sees the right one plainly (Priority: P2)

A quizzer confuses two verses and types the wrong one in full. Instead of a line of struck-through
words, the back shows the correct verse as it normally appears, with what they typed shown beneath
it in muted text and a note of how few words matched.

**Why this priority**: Mixing up verses is a real and recurring mistake, and the current view is at
its worst here. It ranks below near-misses only because it is less frequent.

**Independent Test**: On a John 1:10 card, type John 1:15 in full, flip, and confirm the back shows
John 1:10 unmarked with the typed text below it.

**Acceptance Scenarios**:

1. **Given** a Recitation card for John 1:10, **When** the reader types the text of John 1:15 and
   flips, **Then** the back shows John 1:10 exactly as an un-typed card would, followed by the
   reader's text in muted style and a count of matching words (for example "2 of 19 words match").
2. **Given** an answer where fewer than half of the verse's words were recalled but more than half
   of what was typed is in the verse, **When** the reader flips, **Then** the proofread view is
   shown, not the fallback.
3. **Given** an answer where at least half of the verse's words were recalled, **When** the reader
   flips, **Then** the proofread view is shown, however many extra words were typed.

---

### User Story 3 - Reader who stopped early sees the rest of the verse in place (Priority: P3)

A quizzer recites the opening of a verse, gets stuck, and flips. The back shows the words they
typed, then a caret where they stopped, with the rest of the verse above it as a correction label. A
label that long wraps to the width of the line rather than overflowing; the same holds for any long
correction, such as a long reworded phrase.

**Why this priority**: Partial recall is a deliberate, supported use of the typed answer (the diff
already prefers matching a reader's opening words). It must not be mistaken for a wrong verse, and a
long run of missing words has to fit on a phone-width card without overlapping anything.

**Independent Test**: On a 19-word verse, type only the first four words correctly, flip, and
confirm the four words show in the verse colour followed by a caret with the remaining fifteen words
above it, wrapped within the card.

**Acceptance Scenarios**:

1. **Given** a Recitation card for John 1:10, **When** the reader types "He was in the" and flips,
   **Then** those four words appear in the verse colour, followed by a caret with "world, and the
   world was made through Him, and the world did not know Him." above it as a label.
2. **Given** a correction label wider than the remaining line, **When** the reader flips, **Then**
   the mark starts on the next line and its label wraps within the card's width, never overlapping
   other text or extending past the card edge.
3. **Given** any replacement or skip, whatever its length or position, **When** the reader flips,
   **Then** it is shown the same way: the verse's words above, the reader's struck words or a caret
   below.

---

### User Story 4 - Reader who reworded a phrase sees one correction, not a scatter (Priority: P4)

A quizzer paraphrases part of a verse, so a few small words happen to coincide with the verse's
wording in between the differences. The back shows the reworded stretch as one struck phrase with
the verse's phrase above it, rather than a sequence of tiny unrelated marks.

**Why this priority**: Paraphrase is a common memorization slip and the scattered form is hard to
read, but it only arises when two edits sit very close together, so it matters less than the cases
above.

**Independent Test**: On John 1:14, type "...the glory of the one and only Son from the Father..."
in place of "...the glory as of the only begotten of the Father...", flip, and confirm one
correction spans the whole reworded stretch.

**Acceptance Scenarios**:

1. **Given** two mistakes separated by at most two matching words of at most four letters each,
   **When** the reader flips, **Then** the two mistakes and the words between them appear as one
   struck phrase with the verse's corresponding phrase above it.
2. **Given** two mistakes separated by three or more matching words, or by any matching word longer
   than four letters, **When** the reader flips, **Then** the two mistakes are shown separately and
   the words between them appear as correct.

---

### User Story 5 - Reader's typed club list is marked the same way (Priority: P5)

A quizzer types the verse numbers they believe belong to a club in a chapter and flips. Correct
numbers keep their own verse colours, numbers that do not belong are struck through, and each missed
number appears above a caret at its place in the sorted list, labelled in its own verse colour.

**Why this priority**: Club-list cards share the same comparison and currently use the same hard to
read styling. Matching the recitation look keeps one visual language, but club-list answers are
short, so the gain per card is smaller.

**Independent Test**: For a chapter club of verses 1, 3, 4, 12, 14, and 29, type "1, 3, 5, 12, 14,
18", flip, and confirm 5 and 18 are struck, and 4 and 29 appear above carets in their own verse
colours.

**Acceptance Scenarios**:

1. **Given** the club 1, 3, 4, 12, 14, 29, **When** the reader types "1, 3, 5, 12, 14, 18" and
   flips, **Then** the back reads 1, 3, then a caret labelled 4, then 5 struck through, then 12, 14,
   then 18 struck through, then a caret labelled 29, with commas only between typed numbers.
2. **Given** the same club, **When** the reader types every member in any order, **Then** the back
   shows the full list in ascending order with no marks.

### Edge Cases

* **No typed answer.** Flipping with an empty or whitespace-only answer shows the back exactly as it
  does today. Typing remains optional.
* **Exact answer.** An answer that matches the verse, ignoring case and punctuation, shows the verse
  with no marks.
* **Case and punctuation.** Differences only in capitalization or punctuation are never marked.
  Matched words display in the verse's own form, so the verse's punctuation and capitals show.
* **FTV prefix.** On FTV cards, the words shown on the front are excluded from the comparison, as
  today; only the continuation is marked up.
* **Repeated words.** Where a typed word could match several places in the verse, the earliest
  plausible place is used, as today, so a reader who typed only the opening is not marked as having
  skipped it. Where a verse word could match several of the reader's typed words, the earliest typed
  one is used (FR-014).
* **Correction longer or shorter than the typed text.** Each mark takes the width of the wider of
  the two, so a correction never overlaps a neighbouring word.
* **Correction longer than the line.** The mark starts on a fresh line and its label wraps within
  the card's width, making that line taller; the card never scrolls sideways.
* **Mistake at the very start or end of the line.** Labels stay within the card.
* **Two verses run together.** All of the verse was recalled, so the proofread view is shown: the
  recited verse matches in full, including its last word, and the whole extra verse follows it,
  struck through as one stretch.
* **Club list input that is not a list of numbers.** Shown as typed, as today, rather than
  discarded. Repeated numbers count as extras, as today.
* **Spelling dialect.** The expected side of the comparison uses the same dialect the reader was
  shown, as already required by spec 001 FR-013.

## Requirements _(mandatory)_

### Functional Requirements

* **FR-001**: When a reader flips a Recitation, FTV, or chapter club-list card with a non-empty
  typed answer, the back MUST show that answer marked up against the expected text. With an empty or
  whitespace-only answer, the back MUST be unchanged from current behaviour.
* **FR-002**: The marked-up line MUST follow the order of the reader's typed words.
* **FR-003**: Typed words that match the expected text MUST appear in the verse colour, in the
  expected text's form (its capitalization and punctuation), with no other mark.
* **FR-004**: Where typed words stand in place of expected words, the typed words MUST appear struck
  through and uncoloured, with the expected words shown as a label directly above them.
* **FR-005**: Typed words with no counterpart in the expected text MUST appear struck through and
  uncoloured, with no label.
* **FR-006**: Expected words with no counterpart in the typed answer MUST be shown as a label above
  a caret at the position they belong. Every replacement and skip MUST take this same
  above-and-below form whatever its length or position in the line; there is no alternative inline
  form.
* **FR-007**: Labels MUST carry the verse colour on a soft tint of that colour, so that colour
  always means "the verse" and uncoloured text always means "what the reader typed". A mark for a
  reader's mistake MUST NOT use the verse colour or the grade red.
* **FR-008**: Every wrong word MUST be marked the same way, regardless of how close its spelling is
  to the expected word.
* **FR-009**: A label MUST NOT overlap neighbouring text or extend outside the card. Each mark MUST
  be as wide as the wider of its label and its typed words, up to the card's line width; a label
  wider than that MUST wrap, making its line taller.
* **FR-010**: When two mistakes are separated only by a run of at most two matching words, each of
  at most four letters, the mistakes and the words between them MUST be presented as one
  replacement. This merging MUST NOT apply to club-list answers.
* **FR-011**: When fewer than half of the expected words were matched AND fewer than half of the
  typed words were matched, the back MUST show the expected text unmarked, as it appears with no
  typed answer, followed by the typed answer in muted style and the count of matched words out of
  expected words. This fallback MUST NOT apply to club-list answers.
* **FR-012**: On club-list cards, correct numbers MUST appear in their own verse colours, typed
  numbers not in the club MUST appear struck through and uncoloured, and each missed number MUST
  appear as a label above a caret at its position in ascending order, coloured in that number's own
  verse colour. Commas MUST separate typed numbers only.
* **FR-013**: Club-list answers MUST stay order-insensitive. Input that is not a list of numbers and
  repeated numbers MUST be treated as they are today.
* **FR-014**: Comparison rules MUST be unchanged: case, punctuation, and whitespace are ignored, the
  FTV prefix is excluded, and the expected side is in the reader's displayed dialect. One tie-break
  changes: where an expected word could match more than one of the typed words equally well, the
  earliest typed occurrence MUST be chosen, mirroring the existing preference for the earliest
  expected occurrence.
* **FR-015**: The markup MUST NOT grade the card. Grading stays the reader's own 1 to 4 choice.
* **FR-016**: For every mark, both what the reader typed and what the verse says MUST be available
  to a reader who cannot see the visual layout, such as through assistive technology or a hover
  description.
* **FR-017**: The marked-up back MUST be readable in light and dark themes and at phone width
  without sideways scrolling.

### Key Entities

* **Typed answer**: What the reader entered before flipping. Optional; empty means "recited aloud".
* **Expected text**: The verse text (or FTV continuation, or sorted club members) the answer is
  compared against, in the reader's dialect.
* **Edit**: One stretch of difference between the two: a replacement (typed words in place of
  expected words), an addition (typed words only), or a skip (expected words only). Everything
  between edits is a match.
* **Correction label**: The expected words for a replacement or skip, shown in the verse colour.
* **Caret**: The mark shown in the line where skipped words belong, with their label above it.
* **Match measures**: The share of expected words the reader matched, and the share of typed words
  that matched. Together they decide between the proofread view and the wrong-verse fallback.

## Success Criteria _(mandatory)_

### Measurable Outcomes

* **SC-001**: For each of the seven reference cases (one-word swap on FTV John 1:11, near-miss on
  John 1:1, wrong word then stopping early on John 1:3, paraphrase on John 1:14, stopping after four
  words on John 1:10, two verses run together, and the wrong verse 1:15 on a 1:10 card), the back
  shows exactly the presentation described in this spec: the proofread view for the first six and
  the fallback for the last.
* **SC-002**: On all ten verse colours, in both light and dark themes, no mark for a reader's
  mistake is rendered in the verse colour or in red.
* **SC-003**: At a phone-width card (360 pixels wide) and at desktop width, zero correction labels
  overlap neighbouring text or extend outside the card across the reference cases.
* **SC-004**: An answer identical to the verse, apart from case and punctuation, shows zero marks.
* **SC-005**: An empty typed answer produces a back identical to the current one.
* **SC-006**: Typing only the first word of a verse correctly, for any verse, never triggers the
  wrong-verse fallback.
* **SC-007**: A complete club list typed in any order shows zero marks.

## Assumptions

* **The thresholds are calibrated on examples, not measured.** Half of each measure for the
  fallback, and at most two matching words of at most four letters for merging, were chosen against
  the seven reference cases in the mockups. They are starting values, open to tuning from real use.
* **Merging trades some precision for readability.** Small words that did match are shown as part of
  a struck phrase when they sit between two mistakes. This was accepted deliberately.
* **Close misspellings are wrong words.** Recognizing "do" for "to" as a near miss would need fuzzy
  word matching, which the original feature named as a follow-up and this spec leaves out of scope.
  The separate "letter slip" styling explored in mockups was rejected.
* **No automatic grading.** Considered and rejected in issue #138; the reader still grades.
* **Citation cards are out of scope.** They have no typed answer today.
* **The comparison changes only by one tie-break.** The word-level matching is reused as it is,
  except that ties on the typed side now go to the earliest typed word, as ties on the verse side
  already did. Without it, a reader who runs past the end of a verse sees the verse's last word
  matched against the next verse's last word, splitting the extra verse in two. This is a defect in
  the current diff too, fixed here because the proofread view makes it conspicuous.
* **Type-to-recite is undocumented today.** No page in `docs/` covers it, so this feature adds one,
  per the constitution's rule that `docs/` describes behaviour.
* **The web app is the only surface.** The desktop app wraps the same bundle and inherits the
  change.
