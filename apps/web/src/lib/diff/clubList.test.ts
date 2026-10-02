import { describe, expect, it } from 'vitest';

import { normaliseClubListAnswer, sortClubListEdits } from './clubList';
import { wordDiff } from './wordDiff';

/** Core emits `chapterMembers` ascending, and `CardPrompt` joins them
 *  as-is for the diff's canonical side. */
function expectedFrom(members: number[]): string {
  return members.join(', ');
}

function kinds(expected: string, typed: string): string[] {
  return wordDiff(expected, normaliseClubListAnswer(typed)).map((d) => d.kind);
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
    const diff = wordDiff(expectedFrom(members), normaliseClubListAnswer('1, 3'));

    expect(diff.filter((d) => d.kind === 'missing').map((d) => d.raw)).toEqual(['16']);
  });

  // `raw` keeps the token as typed, comma and all — the diff matches on
  // the normalised form and renders the original.
  it('marks a verse the user invented', () => {
    const diff = wordDiff(expectedFrom(members), normaliseClubListAnswer('1, 3, 9, 16'));

    expect(diff.filter((d) => d.kind === 'extra').map((d) => d.raw)).toEqual(['9,']);
  });

  // parseVerseList returns null for anything non-numeric, so the raw text
  // still reaches the diff — showing what was typed beats showing nothing.
  it('still diffs input it cannot parse', () => {
    const diff = wordDiff(expectedFrom(members), normaliseClubListAnswer('one, three'));

    expect(diff.some((d) => d.kind === 'extra')).toBe(true);
    expect(diff.filter((d) => d.kind === 'missing').map((d) => d.raw)).toEqual(['1,', '3,', '16']);
  });

  it('sorts whatever the user typed', () => {
    expect(normaliseClubListAnswer('16, 1, 3')).toBe('1, 3, 16');
  });
});

describe('chapter club-list edit order', () => {
  const members = [1, 3, 4, 12, 14, 29];

  function ordered(typed: string): string[] {
    const diff = sortClubListEdits(wordDiff(expectedFrom(members), normaliseClubListAnswer(typed)));
    return diff.map((d) => `${d.kind} ${d.raw.replace(',', '')}`);
  }

  // The diff leaves the order inside a run of edits arbitrary; a reader
  // expects the list ascending throughout.
  it('puts missed and invented verses in ascending order', () => {
    expect(ordered('1, 3, 5, 12, 14, 18')).toEqual([
      'match 1',
      'match 3',
      'missing 4',
      'extra 5',
      'match 12',
      'match 14',
      'extra 18',
      'missing 29',
    ]);
  });

  it('leaves a complete list as matches', () => {
    expect(ordered('29, 1, 14, 3, 12, 4').every((d) => d.startsWith('match'))).toBe(true);
  });

  it('keeps a token it cannot read as a number', () => {
    expect(ordered('1, 3, 4, 12, 14, 29, x')).toContain('extra x');
  });

  // `parseVerseList` rejects "4-5", so the answer reaches the diff unsorted
  // and must keep the diff's order rather than be read as 4.
  it('leaves an answer that is not all whole numbers in diff order', () => {
    const diff = wordDiff(expectedFrom(members), normaliseClubListAnswer('12, 4-5'));

    expect(sortClubListEdits(diff)).toEqual(diff);
  });

  it('keeps a repeated verse as an extra', () => {
    expect(ordered('1, 1, 3, 4, 12, 14, 29').filter((d) => d === 'extra 1')).toHaveLength(1);
  });
});
