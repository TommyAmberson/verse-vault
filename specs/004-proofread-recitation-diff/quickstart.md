# Quickstart: Validating the Proofread Recitation Diff

How to prove the feature works. Automated checks cover the edit logic; the visual requirements are
checked by hand against the reference cases, which are the same seven used in the spec's SC-001.

## Prerequisites

```
pnpm install
wasm-pack build crates/wasm --target nodejs --out-dir pkg
bash tools/build-wasm-web.sh
pnpm dev:all
```

A signed-in reader enrolled in the John material, with Recitation, FTV, and chapter club-list cards
reachable in Review or Memorize.

## Automated

```
pnpm --filter @verse-vault/web test
pnpm --filter @verse-vault/web type-check
```

`wordDiff.test.ts` covers the typed-side tie-break with the run-together case. The edit-logic tests
encode the seven reference cases from the spec and the threshold boundaries (two versus three glue
words, four versus five letters, measures just under and at 50%). `clubList.test.ts` gains the
ascending order inside edit runs. Existing tests keep passing unchanged.

## Reference cases (SC-001)

Type each answer, flip, and compare with [the contract](./contracts/card-back-markup.md).

| Card                 | Type                                                                                                                                                                 | Expect                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| FTV John 1:11        | `do His own, and His own did not receive Him.`                                                                                                                       | `do` struck, `to` above it; rest in verse colour                                                     |
| Recitation John 1:1  | `In the beginning was the Word and the Word was with the Lord, and the Word was God`                                                                                 | `the Lord,` struck, `God,` above; missing comma not marked                                           |
| Recitation John 1:3  | `All things were made by Him, and without Him nothing was made`                                                                                                      | `by` struck under `through`; a caret at the end with `that was made.` above                          |
| Recitation John 1:14 | `And the Word became flesh and made His dwelling among all of us, and we saw His glory, the glory of the one and only Son from the Father, full of grace and truth.` | one merged correction above the struck "of the one and only Son from"; `all of` struck, no label     |
| Recitation John 1:10 | `He was in the`                                                                                                                                                      | four words in verse colour, then a caret with the rest of the verse above it, wrapped (not fallback) |
| Recitation John 1:10 | John 1:10 followed by John 1:11                                                                                                                                      | 1:10 unmarked including its last "Him.", then all of 1:11 struck as one stretch (not fallback)       |
| Recitation John 1:10 | the text of John 1:15                                                                                                                                                | fallback: plain 1:10, then `You typed (2 of 19 words match)`                                         |

## Scenario 1: Colour rule (FR-007, SC-002)

1. Type one mistake on a Recitation card for each of John 1:1 to 1:10, so every verse colour appears
   once.
2. **Expect**: no struck word, caret, or line is red or verse-coloured; every label is.
3. Repeat in the other theme (light and dark follow the OS setting).

## Scenario 2: Layout (FR-009, FR-017, SC-003)

1. Open the dev server in a 360px-wide responsive viewport.
2. Run the John 1:3, John 1:14, and "He was in the" cases.
3. **Expect**: no label overlaps neighbouring words or crosses the card edge; a label wider than the
   line wraps and its mark starts on a new line; lines without marks keep ordinary spacing; no
   sideways scroll.
4. Run the wrong-verse case. **Expect**: the fallback verse at the normal, un-typed size.

## Scenario 3: Unchanged paths (FR-001, SC-004, SC-005)

1. Flip a Recitation card with nothing typed. **Expect**: today's back.
2. Type the verse exactly, with different capitals and no punctuation. **Expect**: zero marks.
3. Flip an FTV card leaving only the prefilled words. **Expect**: today's back.

## Scenario 4: Club list (FR-012, FR-013, SC-007)

1. On a chapter club-list card, type the members out of order. **Expect**: ascending list, no marks.
2. Type one wrong number and leave one out. **Expect**: the wrong number struck in place, the missed
   one above a caret in its own verse colour, commas only between typed numbers.
3. Type a word that is not a number. **Expect**: shown struck as typed.

## Scenario 5: Assistive output (FR-016)

1. Inspect a `replace` mark. **Expect**: typed words in `<del>`, the label in `<ins>`, and a `title`
   naming both.
