import { describe, expect, it } from 'vitest';

import type { Section } from './apibible-cache.js';
import {
  applyAnnotations,
  composeRender,
  extractVerseNodes,
  passageIdOf,
  resolveHeadingTitle,
  splitIntoPhrases,
  tokenize,
} from './render.js';

// Excerpt of a real api.bible NKJV chapter response — verses 1-2 of 1 Cor 1.
// Includes inline `<span class="it">` (translator-supplied italics) and
// the verse-marker `<span class="v">` chrome.
const SAMPLE_CHAPTER = [
  '<p class="p">',
  '<span data-number="1" data-sid="1CO 1:1" class="v">1</span>',
  'Paul, called <span class="it">to be</span> an apostle of Jesus Christ through the will of God, and Sosthenes <span class="it">our</span> brother,',
  '<span data-number="2" data-sid="1CO 1:2" class="v">2</span>',
  'To the church of God which is at Corinth.',
  '</p>',
].join('');

// Excerpt of 1 Cor 1:31 — small-caps + bold for YHWH-as-LORD.
const SAMPLE_LORD = [
  '<p class="p">',
  '<span data-number="31" data-sid="1CO 1:31" class="v">31</span>',
  'glory in the <span class="sc"><span class="bd">Lord</span></span>.',
  '</p>',
].join('');

describe('extractVerseNodes', () => {
  it('slices nodes between adjacent verse markers', () => {
    const nodes = extractVerseNodes(SAMPLE_CHAPTER, '1 Corinthians', 1, 1);
    // Expect text + spans for verse 1 only; the verse-2 marker stops it.
    expect(nodes.length).toBeGreaterThan(0);
    const tokens = tokenize(nodes);
    // "Paul, called to be an apostle of Jesus Christ through the will of
    // God, and Sosthenes our brother," → 18 tokens.
    expect(tokens.length).toBe(18);
  });

  it('returns empty when the verse is missing from the chapter', () => {
    const nodes = extractVerseNodes(SAMPLE_CHAPTER, '1 Corinthians', 1, 99);
    expect(nodes).toHaveLength(0);
  });
});

describe('tokenize', () => {
  it('preserves inline class wrappers per token', () => {
    const nodes = extractVerseNodes(SAMPLE_CHAPTER, '1 Corinthians', 1, 1);
    const tokens = tokenize(nodes);
    // "to" and "be" each get cloned `<span class="it">` wrapping.
    expect(tokens[2]).toBe('<span class="it">to</span>');
    expect(tokens[3]).toBe('<span class="it">be</span>');
    // "our" is the 17th word (index 16) — between Sosthenes and brother,.
    expect(tokens[16]).toBe('<span class="it">our</span>');
    // Plain words are unwrapped.
    expect(tokens[0]).toBe('Paul,');
    expect(tokens[1]).toBe('called');
  });

  it('preserves nested small-caps + bold wrapping', () => {
    const nodes = extractVerseNodes(SAMPLE_LORD, '1 Corinthians', 1, 31);
    const tokens = tokenize(nodes);
    // "Lord." should keep both wrappers.
    const lord = tokens[tokens.length - 1]!;
    expect(lord).toContain('<span class="sc">');
    expect(lord).toContain('<span class="bd">');
    expect(lord).toContain('Lord');
  });
});

describe('applyAnnotations', () => {
  it('wraps the requested word index', () => {
    const tokens = ['the', 'first', 'word'];
    const result = applyAnnotations(tokens, [{ wordIndex: 1, kind: 'bold' }]);
    expect(result).toEqual(['the', '<b>first</b>', 'word']);
  });

  it('layers bold-italic on top of api.bible markup', () => {
    const tokens = ['plain', '<span class="it">cross</span>'];
    const result = applyAnnotations(tokens, [{ wordIndex: 1, kind: 'boldItalic' }]);
    expect(result[1]).toBe('<b><i><span class="it">cross</span></i></b>');
  });

  it('skips out-of-range word indices defensively', () => {
    const tokens = ['only'];
    const result = applyAnnotations(tokens, [{ wordIndex: 99, kind: 'bold' }]);
    expect(result).toEqual(['only']);
  });
});

describe('splitIntoPhrases', () => {
  it('cuts the token sequence at the boundaries given by counts', () => {
    expect(splitIntoPhrases(['a', 'b', 'c', 'd', 'e'], [2, 3])).toEqual(['a b', 'c d e']);
  });
});

describe('composeRender end-to-end', () => {
  it('produces phraseHtml + ftvHtml + heading titles for verse 1', () => {
    const sections: Section[] = [
      {
        id: '1CO.S1',
        title: 'Greeting',
        firstVerseId: '1CO.1.1',
        lastVerseId: '1CO.1.3',
      },
    ];
    const composed = composeRender(
      {
        book: '1 Corinthians',
        chapter: 1,
        verse: 1,
        // Real Cor 1:1 in NKJV: 18 tokens total; deck splits 14/4 with
        // Sosthenes (verse word index 15) bolded. Matches the structural
        // data emitted by tools/derive_structure.py for verse 0.
        phraseWordCounts: [14, 4],
        annotations: [{ wordIndex: 15, kind: 'bold' }],
        ftvWordCount: 2,
        headings: [
          {
            headingIdx: 0,
            startChapter: 1,
            startVerse: 1,
            endChapter: 1,
            endVerse: 3,
          },
        ],
      },
      SAMPLE_CHAPTER,
      sections,
    );
    expect(composed.phraseHtml).toHaveLength(2);
    expect(composed.phraseHtml[0]).toContain('Paul,');
    // Sosthenes is verse word index 15: phrase 1 sub-index 1 (after "and").
    expect(composed.phraseHtml[1]).toContain('<b>Sosthenes</b>');
    expect(composed.ftvHtml).toBe('Paul, called');
    expect(composed.headings).toEqual([{ headingIdx: 0, title: 'Greeting' }]);
  });

  it('falls back to api tokens when token count mismatches', () => {
    // Deck claims 5 tokens but api.bible has 18. Expected behaviour:
    // non-throwing fallback that still renders the verse without
    // user annotations.
    const sections: Section[] = [];
    const composed = composeRender(
      {
        book: '1 Corinthians',
        chapter: 1,
        verse: 1,
        phraseWordCounts: [3, 2],
        annotations: [{ wordIndex: 0, kind: 'bold' }],
        ftvWordCount: 2,
        headings: [],
      },
      SAMPLE_CHAPTER,
      sections,
    );
    expect(composed.phraseHtml).toHaveLength(2);
    // No <b> wrapping in the fallback — user annotations dropped.
    expect(composed.phraseHtml.join(' ')).not.toContain('<b>');
    // All 18 api tokens should be covered (visible-word count, ignoring
    // any spans the api injected).
    const visible = composed.phraseHtml
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim()
      .split(/\s+/);
    expect(visible.length).toBe(18);
  });

  it('returns null heading title when no section matches the range', () => {
    const sections: Section[] = [
      {
        id: 'X',
        title: 'Different',
        firstVerseId: '1CO.5.1',
        lastVerseId: '1CO.5.5',
      },
    ];
    const composed = composeRender(
      {
        book: '1 Corinthians',
        chapter: 1,
        verse: 1,
        phraseWordCounts: [14, 4],
        annotations: [],
        ftvWordCount: null,
        headings: [{ headingIdx: 7, startChapter: 1, startVerse: 1, endChapter: 1, endVerse: 3 }],
      },
      SAMPLE_CHAPTER,
      sections,
    );
    expect(composed.headings).toEqual([{ headingIdx: 7, title: null }]);
    expect(composed.ftvHtml).toBeNull();
  });
});

describe('resolveHeadingTitle', () => {
  it('matches by (book, startChapter, startVerse) → firstVerseId', () => {
    const sections: Section[] = [
      { id: 'a', title: 'Greeting', firstVerseId: '1CO.1.1', lastVerseId: '1CO.1.3' },
      { id: 'b', title: 'Sectarianism', firstVerseId: '1CO.1.10', lastVerseId: '1CO.1.17' },
    ];
    expect(
      resolveHeadingTitle(
        { headingIdx: 0, startChapter: 1, startVerse: 10, endChapter: 1, endVerse: 17 },
        '1 Corinthians',
        sections,
      ),
    ).toBe('Sectarianism');
  });
});

describe('passageIdOf', () => {
  it('formats {USX_BOOK}.{chapter}', () => {
    expect(passageIdOf('1 Corinthians', 3)).toBe('1CO.3');
    expect(passageIdOf('John', 3)).toBe('JHN.3');
  });
});
