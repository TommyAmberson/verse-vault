import { parseVerseList } from '../schedule'
import type { DiffItem } from './wordDiff'

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

/** Puts the marked-up list in ascending order. Both sides are already
 *  sorted, so every missed or invented verse belongs between the matches
 *  around it by value, and a stable sort by verse number orders each run
 *  of edits without moving anything else. An answer that isn't all
 *  numbers was never sorted (`normaliseClubListAnswer`), so it keeps the
 *  diff's order. */
export function sortClubListEdits(items: DiffItem[]): DiffItem[] {
  if (!items.every((it) => verseNumber(it) !== null)) return items
  return [...items].sort((a, b) => verseNumber(a)! - verseNumber(b)!)
}

/** The verse number a club-list token stands for, or null for a token
 *  that isn't one. Tokens keep their trailing comma from the diff. The
 *  whole token must be a positive integer, as `parseVerseList` requires,
 *  so "4-5" or "3x" isn't quietly read as a number. */
export function verseNumber(item: DiffItem): number | null {
  const match = /^(\d+),?$/.exec(item.raw)
  const n = match ? Number(match[1]) : 0
  return n > 0 ? n : null
}
