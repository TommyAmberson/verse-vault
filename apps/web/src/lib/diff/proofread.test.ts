import { describe, expect, it } from 'vitest';

import { type Segment, toSegments, wrongVerse } from './proofread';
import { wordDiff } from './wordDiff';

const JOHN_1_1 = 'In the beginning was the Word, and the Word was with God, and the Word was God.';
const JOHN_1_11_CONTINUATION = 'to His own, and His own did not receive Him.';
const JOHN_1_10 =
  'He was in the world, and the world was made through Him, and the world did not know Him.';
const JOHN_1_11 = 'He came to His own, and His own did not receive Him.';
const JOHN_1_15 =
  'This is He of whom I said, "After me comes a Man who is preferred before me, for He was before me."';

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

// Long and trailing edits take the same form as any other (FR-006), so
// the segments carry nothing about length or position.
describe('long and trailing edits', () => {
  it('reads stopping early as one trailing skip', () => {
    const rest = JOHN_1_10.split(' ').slice(4);

    expect(segments(JOHN_1_10, 'He was in the')).toEqual([
      { kind: 'match', words: ['He', 'was', 'in', 'the'] },
      { kind: 'skip', expected: rest },
    ]);
    expect(rest).toHaveLength(15);
  });

  it('reads a wrong word then stopping early as a replacement and a skip', () => {
    const verse = 'All things were made through Him, and without Him nothing was made that was made.';
    const typed = 'All things were made by Him, and without Him nothing was made';

    expect(edits(verse, typed)).toEqual([
      { kind: 'replace', typed: ['by'], expected: ['through'] },
      { kind: 'skip', expected: ['that', 'was', 'made.'] },
    ]);
  });
});

describe('merging reworded phrases', () => {
  const JOHN_1_14 =
    'And the Word became flesh and dwelt among us, and we beheld His glory, the glory as of the only begotten of the Father, full of grace and truth.';

  it('reads a paraphrase as one correction', () => {
    const typed =
      'And the Word became flesh and made His dwelling among all of us, and we saw His glory, the glory of the one and only Son from the Father, full of grace and truth.';

    expect(edits(JOHN_1_14, typed)).toEqual([
      { kind: 'replace', typed: ['made', 'His', 'dwelling'], expected: ['dwelt'] },
      { kind: 'add', typed: ['all', 'of'] },
      { kind: 'replace', typed: ['saw'], expected: ['beheld'] },
      {
        kind: 'replace',
        typed: ['of', 'the', 'one', 'and', 'only', 'Son', 'from'],
        expected: ['as', 'of', 'the', 'only', 'begotten', 'of'],
      },
    ]);
  });

  it('merges across at most two glue words', () => {
    expect(edits('alpha of the bravo end', 'zulu of the yankee end')).toEqual([
      { kind: 'replace', typed: ['zulu', 'of', 'the', 'yankee'], expected: ['alpha', 'of', 'the', 'bravo'] },
    ]);
    expect(edits('alpha of the a bravo end', 'zulu of the a yankee end')).toHaveLength(2);
  });

  it('merges across glue words of at most four letters', () => {
    expect(edits('alpha from bravo end', 'zulu from yankee end')).toHaveLength(1);
    expect(edits('alpha among bravo end', 'zulu among yankee end')).toHaveLength(2);
  });

  it('never folds a match run at the start or end', () => {
    expect(segments('of alpha', 'of zulu').map((s) => s.kind)).toEqual(['match', 'replace']);
    expect(segments('alpha of', 'zulu of').map((s) => s.kind)).toEqual(['replace', 'match']);
  });

  // The fallback counts the diff, not the merged segments, so glue words
  // folded into a correction still count as matched.
  it('leaves the wrong-verse measures alone', () => {
    const typed = 'And the Word became flesh and dwelt among us, and we beheld His glory, the glory of the one and only Son from the Father, full of grace and truth.';

    expect(wrongVerse(wordDiff(JOHN_1_14, typed))).toBeNull();
  });
});

describe('wrongVerse', () => {
  function check(expected: string, typed: string) {
    return wrongVerse(wordDiff(expected, typed));
  }

  it('falls back when another verse was recited', () => {
    expect(check(JOHN_1_10, JOHN_1_15)).toEqual({ matched: 2, expected: 19 });
  });

  // Recall 4 of 19, but everything typed is in the verse.
  it('keeps the proofread view when the reader stopped early', () => {
    expect(check(JOHN_1_10, 'He was in the')).toBeNull();
  });

  // Precision 19 of 31, but the whole verse was recalled.
  it('keeps the proofread view when the reader ran into the next verse', () => {
    expect(check(JOHN_1_10, `${JOHN_1_10} ${JOHN_1_11}`)).toBeNull();
  });

  it('needs both measures under one half', () => {
    // Both exactly one half.
    expect(check('one two three four', 'one two five six')).toBeNull();
    // Recall one half, precision two fifths.
    expect(check('one two three four', 'one two five six seven')).toBeNull();
    // Recall two fifths, precision one half.
    expect(check('one two three four five', 'one two six seven')).toBeNull();
    // Both two fifths.
    expect(check('one two three four five', 'one two six seven eight')).toEqual({
      matched: 2,
      expected: 5,
    });
  });
});
