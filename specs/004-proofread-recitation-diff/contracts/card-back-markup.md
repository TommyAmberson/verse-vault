# Contract: Card Back Markup With a Typed Answer

The presentation contract between the edit logic and the card back, for Recitation, Ftv, and
ChapterClubList cards flipped with a non-empty typed answer. It fixes what each piece of the answer
looks like and what it exposes, not class names or element nesting beyond the semantic elements
named here.

## Prose cards (Recitation, Ftv)

The body is the typed answer in typed order, at the diff type size: 1.3rem with a line-height of 1.8
(mockup-approved). The fallback below does not use this size.

| Piece          | Visible form                                                          | Exposed as                                  |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| Matched word   | Expected token, in the verse colour, no mark                          | Plain text                                  |
| `replace` edit | Label on top; typed words below in text colour with a 1px grey strike | `<del>` typed words, `<ins>` label, `title` |
| `add` edit     | Typed words in text colour with a 1px grey strike; no label           | `<del>`, `title`                            |
| `skip` edit    | Label on top; a grey caret below                                      | `<ins>` label, `title`                      |

**Label**: expected words in the verse colour, bold, card face, 0.95rem, on a 16% tint of the verse
colour, rounded. Never the grade red, never uncoloured.

**One form** (FR-006): every `replace` and `skip` takes the stacked form above, whatever its length
or position. There is no inline variant.

**Line and caret**: a dedicated grey, distinct from the muted text colour, mockup-approved as light
`#a59d92` and dark `#a8a096`.

**Width** (FR-009): a mark is as wide as the wider of its label and its typed words, up to the line
width. A wider label wraps inside the mark, which then starts on its own line and makes that line
taller. Its bottom row sits on the sentence's baseline. Nothing overhangs neighbouring text or the
card edge.

**`title`**: names both sides, for example `You typed: do. Verse: to.`, `Not in the verse.`, or
`Skipped: that was made.`.

## Wrong-verse fallback (prose cards)

When recall and precision are both under 50%:

1. The expected text exactly as the un-typed back renders it, at its normal size.
2. Below it, in muted text: a label `You typed (N of M words match)` and the typed answer as
   entered.

No marks appear in either part.

## Club-list cards

The body is the list in ascending order.

| Piece              | Visible form                                                             | Exposed as             |
| ------------------ | ------------------------------------------------------------------------ | ---------------------- |
| Matched number     | The number in its own verse colour                                       | Plain text             |
| Typed, not in club | The number (or token) in text colour with a 1px grey strike              | `<del>`, `title`       |
| Missed number      | Grey caret in sorted position; number in a label above, own verse colour | `<ins>` label, `title` |

Commas separate adjacent typed numbers only; a caret is separated from its neighbours by spaces.

## Unchanged

* An empty or whitespace-only answer renders the existing back.
* Every non-typed card kind is untouched.
