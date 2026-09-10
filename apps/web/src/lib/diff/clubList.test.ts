import { describe, expect, it } from 'vitest';

import { parseVerseList } from '../schedule';

import { wordDiff } from './wordDiff';

/** What `CardPrompt` feeds the diff for a ChapterClubList card: both
 *  sides through `parseVerseList` (which sorts) so a set answer isn't
 *  judged on the order it was recalled in. Unparsable input falls
 *  through raw. */
function normaliseTyped(input: string): string {
  return parseVerseList(input)?.join(', ') ?? input;
}

function expectedFrom(members: number[]): string {
  return [...members].sort((a, b) => a - b).join(', ');
}

function kinds(expected: string, typed: string): string[] {
  return wordDiff(expected, normaliseTyped(typed)).map((d) => d.kind);
}

describe('chapter club-list answer checking', () => {
  const members = [1, 3, 16];

  it('accepts the right verses in any order', () => {
    expect(kinds(expectedFrom(members), '16, 3, 1')).toEqual(['match', 'match', 'match']);
  });

  it('accepts whitespace instead of commas', () => {
    expect(kinds(expectedFrom(members), '1 3 16')).toEqual(['match', 'match', 'match']);
  });

  it('marks a verse the user left out', () => {
    const diff = wordDiff(expectedFrom(members), normaliseTyped('1, 3'));

    expect(diff.filter((d) => d.kind === 'missing').map((d) => d.raw)).toEqual(['16']);
  });

  // `raw` keeps the token as typed, comma and all — the diff matches on
  // the normalised form and renders the original.
  it('marks a verse the user invented', () => {
    const diff = wordDiff(expectedFrom(members), normaliseTyped('1, 3, 9, 16'));

    expect(diff.filter((d) => d.kind === 'extra').map((d) => d.raw)).toEqual(['9,']);
  });

  // parseVerseList returns null for anything non-numeric, so the raw text
  // still reaches the diff — showing what was typed beats showing nothing.
  it('still diffs input it cannot parse', () => {
    const diff = wordDiff(expectedFrom(members), normaliseTyped('one, three'));

    expect(diff.some((d) => d.kind === 'extra')).toBe(true);
    expect(diff.filter((d) => d.kind === 'missing').map((d) => d.raw)).toEqual(['1,', '3,', '16']);
  });

  it('sorts the canonical side too, so member order never matters', () => {
    expect(expectedFrom([16, 1, 3])).toBe('1, 3, 16');
  });
});
