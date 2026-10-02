/**
 * Shapes a `wordDiff` result into the proofread view of a typed
 * recitation: the reader's words in typed order, with each stretch of
 * difference as one edit. A replacement or skip shows the verse's words
 * as a label over the reader's struck words or a caret; an addition is
 * struck with no label. See docs/type-to-recite.md.
 */

import type { DiffItem } from './wordDiff'

export type Segment =
  | { kind: 'match'; words: string[] }
  | { kind: 'replace'; typed: string[]; expected: string[] }
  | { kind: 'add'; typed: string[] }
  | { kind: 'skip'; expected: string[] }

/** Groups each maximal run of matches, and each maximal run of
 *  differences, into one segment. A difference run with both sides is a
 *  replacement, so a swapped word reads as one correction rather than a
 *  deletion beside an insertion. */
export function toSegments(items: DiffItem[]): Segment[] {
  const out: Segment[] = []
  let k = 0
  while (k < items.length) {
    if (items[k]!.kind === 'match') {
      const words: string[] = []
      while (k < items.length && items[k]!.kind === 'match') words.push(items[k++]!.raw)
      out.push({ kind: 'match', words })
      continue
    }
    const typed: string[] = []
    const expected: string[] = []
    while (k < items.length && items[k]!.kind !== 'match') {
      const it = items[k++]!
      if (it.kind === 'extra') typed.push(it.raw)
      else expected.push(it.raw)
    }
    if (typed.length === 0) out.push({ kind: 'skip', expected })
    else if (expected.length === 0) out.push({ kind: 'add', typed })
    else out.push({ kind: 'replace', typed, expected })
  }
  return out
}
