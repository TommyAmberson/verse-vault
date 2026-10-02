import { describe, expect, it } from 'vitest';

import { wordDiff } from './wordDiff';

const JOHN_1_1 = 'In the beginning was the Word, and the Word was with God, and the Word was God.';
const JOHN_1_10 =
  'He was in the world, and the world was made through Him, and the world did not know Him.';
const JOHN_1_11 = 'He came to His own, and His own did not receive Him.';

function kinds(expected: string, typed: string): string[] {
  return wordDiff(expected, typed).map((d) => d.kind);
}

describe('wordDiff', () => {
  it('matches an exact answer word for word', () => {
    expect(kinds(JOHN_1_10, JOHN_1_10).every((k) => k === 'match')).toBe(true);
  });

  // b434286: typing only the opening must not be read as having skipped it.
  it('prefers the earliest expected occurrence', () => {
    const diff = wordDiff(JOHN_1_1, 'was');
    const firstMatch = diff.findIndex((d) => d.kind === 'match');

    expect(diff.slice(0, firstMatch).map((d) => d.raw)).toEqual(['In', 'the', 'beginning']);
  });

  // Running past the end of a verse: its own last word must match, so the
  // next verse reads as one stretch of extras rather than being split
  // around a stolen "Him.".
  it('prefers the earliest typed occurrence', () => {
    const verseLength = JOHN_1_10.split(' ').length;
    const diff = wordDiff(JOHN_1_10, `${JOHN_1_10} ${JOHN_1_11}`);

    expect(diff.slice(0, verseLength).every((d) => d.kind === 'match')).toBe(true);
    expect(diff.slice(verseLength).map((d) => d.raw)).toEqual(JOHN_1_11.split(' '));
    expect(diff.slice(verseLength).every((d) => d.kind === 'extra')).toBe(true);
  });
});
