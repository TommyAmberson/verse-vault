# Type to recite

How a typed answer is checked and shown on the back of a card. Recitation, FTV, and chapter
club-list cards take an optional typed answer on their front; everything here happens in the web
client when the card is flipped. Spec: `specs/004-proofread-recitation-diff/`.

## What stays the reader's choice

* **Typing is optional.** The reader can recite aloud and flip with an empty box. An empty or
  whitespace-only answer shows the back exactly as an untyped card does.
* **Grading is the reader's.** The markup never grades the card; the reader still picks 1 to 4. The
  marks are there to make that self-grade honest, not to replace it.

## Comparison

`wordDiff` (`apps/web/src/lib/diff/wordDiff.ts`) runs a word-level longest common subsequence
between the expected text and the typed answer.

* **Normalized.** Words compare lowercased with punctuation stripped, so a missing comma or "Lord"
  for "LORD" is not a mistake. A matched word is shown in the verse's own form.
* **Earliest occurrence on both sides.** When a word could match in several places, the earliest is
  used. On the verse side, a reader who typed only the opening isn't marked as having skipped it. On
  the typed side, a reader who ran on into the next verse has the verse's last word matched, and the
  next verse reads as one run of extra words.
* **Expected text.** For Recitation, the whole verse. For FTV, only the continuation: the words
  shown on the front are dropped from the expected side, and from the typed side when the reader
  kept the prefilled prefix. Both sides are in the reader's displayed spelling dialect (spec 001
  FR-013).

## Proofread view

`apps/web/src/lib/diff/proofread.ts` turns the diff into segments, and the `diffHtml` computed in
`CardPrompt.vue` renders them. The line is what the reader typed, in typed order. Colour always
means "the verse" and plain text always means "what you typed".

| Segment     | What it is                             | Shown as                                                  |
| ----------- | -------------------------------------- | --------------------------------------------------------- |
| match       | Typed words that match the verse       | The words in the verse colour                             |
| replacement | Typed words where the verse has others | The verse's words in a tinted label over the struck words |
| addition    | Typed words with no counterpart        | The words struck, no label                                |
| skip        | Verse words the reader left out        | The verse's words in a tinted label over a caret (‸)      |

Each replacement and skip is a small stack in the flow of the line, label on top. Every one takes
this form whatever its length or position, including the rest of a verse after the reader stopped
early. A label wider than the line wraps and makes its line taller, so nothing overlaps or runs off
a phone-width card.

Struck words use `<del>` and labels use `<ins>`, and each mark has a `title` naming both sides, so
the reader's words and the verse's words are both available without the visual layout.

### Merging reworded phrases

A paraphrase often shares a few small words with the verse by chance, which would break one reworded
phrase into a skip, an addition, and a replacement. A match run of at most two words, each at most
four letters, that sits between two edits is folded into one replacement. Typing "of the one and
only Son from" for "as of the only begotten of" shows one correction.

### Wrong verse

When the reader matched under half of the verse's words and under half of their typed words are in
the verse, they recited something else, and the markup would be noise. The back shows the verse as
it reads untyped, then the answer as a muted note with the count of matched words. Both measures
have to be low: stopping early keeps the second one high, and running on into the next verse keeps
the first one high.

## Club lists

A chapter club-list answer is a set of verse numbers, sorted before the comparison so the order they
were recalled in doesn't count (`apps/web/src/lib/diff/clubList.ts`). It takes the same look, per
number, without merging or the wrong-verse fallback.

* Correct numbers keep their own verse colours.
* Numbers not in the club are struck.
* Each missed number sits above a caret in sorted position, tinted in its own verse colour.

Within a run of mistakes the numbers are put in ascending order, so the list reads sorted
throughout. Commas join typed numbers only. Input that isn't a list of numbers is shown as typed,
and a repeated number counts as an extra.

## Tuning

The thresholds (one half for each wrong-verse measure, two words and four letters for glue) are
named constants in `proofread.ts`. They were chosen against seven reference recitations in the
design mockups, not measured from real use, and are open to tuning.
