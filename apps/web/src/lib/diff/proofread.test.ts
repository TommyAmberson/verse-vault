import { describe, expect, it } from 'vitest';

import { type Segment, toSegments } from './proofread';
import { wordDiff } from './wordDiff';

const JOHN_1_1 = 'In the beginning was the Word, and the Word was with God, and the Word was God.';
const JOHN_1_11_CONTINUATION = 'to His own, and His own did not receive Him.';

function segments(expected: string, typed: string): Segment[] {
  return toSegments(wordDiff(expected, typed));
}

function edits(expected: string, typed: string): Segment[] {
  return segments(expected, typed).filter((s) => s.kind !== 'match');
}

describe('toSegments', () => {
  it('reads a one-word swap as a single replacement', () => {
    const typed = 'do His own, and His own did not receive Him.';

    expect(edits(JOHN_1_11_CONTINUATION, typed)).toEqual([
      { kind: 'replace', typed: ['do'], expected: ['to'] },
    ]);
  });

  it('ignores punctuation and pairs a reworded ending as one replacement', () => {
    const typed =
      'In the beginning was the Word and the Word was with the Lord, and the Word was God';

    expect(edits(JOHN_1_1, typed)).toEqual([
      { kind: 'replace', typed: ['the', 'Lord,'], expected: ['God,'] },
    ]);
  });

  it('reads typed words with no counterpart as an addition', () => {
    const typed = 'In the very beginning was the Word, and the Word was with God, and the Word was God.';

    expect(edits(JOHN_1_1, typed)).toEqual([{ kind: 'add', typed: ['very'] }]);
  });

  it('reads verse words left out mid-verse as a skip', () => {
    const typed = 'In the beginning was the Word, and the Word was with God, and was God.';

    expect(edits(JOHN_1_1, typed)).toEqual([{ kind: 'skip', expected: ['the', 'Word'] }]);
  });

  // Matched words carry the verse's form, so its capitals and punctuation
  // show even when the reader typed neither.
  it('keeps the verse form of matched words', () => {
    const typed = 'in the beginning was the word and the word was with god and the word was god';
    const [only] = segments(JOHN_1_1, typed);

    expect(only).toEqual({ kind: 'match', words: JOHN_1_1.split(' ') });
  });

  it('alternates match runs and edits in typed order', () => {
    const typed = 'In the start was the Word, and the Word was with God, and the Word is God.';

    expect(segments(JOHN_1_1, typed).map((s) => s.kind)).toEqual([
      'match',
      'replace',
      'match',
      'replace',
      'match',
    ]);
  });
});
