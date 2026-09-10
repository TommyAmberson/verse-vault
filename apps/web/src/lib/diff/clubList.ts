import { parseVerseList } from '../schedule'

/** A typed chapter-club-list answer, normalised for `wordDiff`.
 *
 *  The answer is a set of verse numbers, so the order it was recalled in
 *  shouldn't read as wrong. `parseVerseList` sorts, and the canonical
 *  side is already ascending, so sorting here makes the word-level diff
 *  order-insensitive without a second diff engine — over two ascending
 *  sequences of distinct numbers, LCS *is* the sorted intersection.
 *
 *  Input `parseVerseList` rejects (a stray word, a malformed number)
 *  falls through raw: showing what was typed beats showing nothing.
 *  Duplicates are deliberately kept — a repeated number is a real extra
 *  token, and quietly swallowing it would hide sloppy input on a card
 *  the learner grades themselves. */
export function normaliseClubListAnswer(input: string): string {
  return parseVerseList(input)?.join(', ') ?? input
}
