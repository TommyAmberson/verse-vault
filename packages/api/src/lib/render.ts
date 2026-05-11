import { type HTMLElement, type Node, NodeType, parse } from 'node-html-parser';

import type { Section } from './apibible-cache.js';
import { bookCodeOf } from './book-codes.js';

export { bookCodeOf, passageIdOf } from './book-codes.js';

/**
 * Server-side composer: combine api.bible's chapter HTML with the deck's
 * structural metadata (phrase word counts + user annotations) to produce
 * per-card render output.
 *
 * api.bible's HTML carries NKJV editorial typography (small caps for
 * YHWH, translator-supplied italics, divine-name bold) as `<span class>`
 * wrappers. The composer keeps those wrappers intact and layers user
 * `<b>`/`<i>` annotations on top — bold-on-bold and italic-on-italic
 * stack harmlessly.
 */

export interface VerseRenderInput {
  book: string;
  chapter: number;
  verse: number;
  phraseWordCounts: number[];
  annotations: { wordIndex: number; kind: 'bold' | 'italic' | 'boldItalic' }[];
  ftvWordCount: number | null;
  headings: HeadingRangeInput[];
}

export interface HeadingRangeInput {
  headingIdx: number;
  startChapter: number;
  startVerse: number;
  endChapter: number;
  endVerse: number;
}

export interface ComposedRender {
  phraseHtml: string[];
  ftvHtml: string | null;
  headings: { headingIdx: number; title: string | null }[];
}

/** Compose HTML for one verse from cached chapter HTML + structural data. */
export function composeRender(
  input: VerseRenderInput,
  chapterHtml: string,
  sections: Section[],
): ComposedRender {
  const verseNodes = extractVerseNodes(chapterHtml, input.book, input.chapter, input.verse);
  const tokens = tokenize(verseNodes);
  const expectedTokens = input.phraseWordCounts.reduce((a, b) => a + b, 0);
  if (tokens.length !== expectedTokens && expectedTokens > 0) {
    // Token count mismatch — likely an api.bible/deck divergence (typo,
    // punctuation difference). Fall back to api.bible's tokens, dropping
    // the user annotations and using the api word counts to split. The
    // verse still renders, just without the keyword highlights.
    const fallbackPhrases = approximatePhrases(tokens, input.phraseWordCounts);
    return {
      phraseHtml: fallbackPhrases,
      ftvHtml:
        input.ftvWordCount != null && input.ftvWordCount > 0
          ? tokens.slice(0, input.ftvWordCount).join(' ')
          : null,
      headings: input.headings.map((h) => ({
        headingIdx: h.headingIdx,
        title: resolveHeadingTitle(h, input.book, sections),
      })),
    };
  }
  const annotated = applyAnnotations(tokens, input.annotations);
  const phraseHtml = splitIntoPhrases(annotated, input.phraseWordCounts);
  const ftvHtml =
    input.ftvWordCount != null && input.ftvWordCount > 0
      ? annotated.slice(0, input.ftvWordCount).join(' ')
      : null;
  const headings = input.headings.map((h) => ({
    headingIdx: h.headingIdx,
    title: resolveHeadingTitle(h, input.book, sections),
  }));
  return { phraseHtml, ftvHtml, headings };
}

/** Pull the inline DOM nodes for one verse out of the chapter HTML. The
 *  verse boundary is the verse-number span (`class="v" data-sid="…"`);
 *  collect nodes after the matching marker, stopping at the next marker
 *  or end of input. */
export function extractVerseNodes(
  chapterHtml: string,
  book: string,
  chapter: number,
  verse: number,
): Node[] {
  const root = parse(chapterHtml);
  const flat = flattenInline(root);
  const targetSid = `${bookCodeOf(book)} ${chapter}:${verse}`;
  let inVerse = false;
  const out: Node[] = [];
  for (const node of flat) {
    if (isVerseMarker(node)) {
      const sid = (node as HTMLElement).getAttribute('data-sid');
      if (sid === targetSid) {
        inVerse = true;
        continue;
      }
      if (inVerse) break;
    } else if (inVerse) {
      out.push(node);
    }
  }
  return out;
}

/** Walk all `<p>` and inline children, yielding the inline sequence. The
 *  paragraph wrappers themselves are treated as transparent — the deck
 *  doesn't care about paragraph boundaries within a verse. */
function flattenInline(root: HTMLElement): Node[] {
  const out: Node[] = [];
  for (const child of root.childNodes) {
    if (child.nodeType === NodeType.ELEMENT_NODE && (child as HTMLElement).tagName === 'P') {
      for (const inner of (child as HTMLElement).childNodes) out.push(inner);
    } else {
      out.push(child);
    }
  }
  return out;
}

function isVerseMarker(node: Node): boolean {
  if (node.nodeType !== NodeType.ELEMENT_NODE) return false;
  const el = node as HTMLElement;
  return el.tagName === 'SPAN' && el.classList.contains('v');
}

/** Tokenize a sequence of DOM nodes into whitespace-separated word tokens
 *  (matching tools/derive_structure.py's locked rule), preserving inline
 *  span wrappers around each token. */
export function tokenize(nodes: Node[]): string[] {
  const out: string[] = [];
  let current = '';

  function emit() {
    if (current.length > 0) {
      out.push(current);
      current = '';
    }
  }

  function walk(node: Node, wrappers: string[]) {
    if (node.nodeType === NodeType.TEXT_NODE) {
      const text = node.text;
      let i = 0;
      while (i < text.length) {
        if (isWs(text[i]!)) {
          emit();
          while (i < text.length && isWs(text[i]!)) i++;
        } else {
          const start = i;
          while (i < text.length && !isWs(text[i]!)) i++;
          current += wrap(text.slice(start, i), wrappers);
        }
      }
      return;
    }
    if (node.nodeType === NodeType.ELEMENT_NODE) {
      const el = node as HTMLElement;
      // Skip verse-marker spans (`class="v"`) entirely — they're chrome,
      // not content. Defensive: extractVerseNodes already excludes them.
      if (el.tagName === 'SPAN' && el.classList.contains('v')) return;
      // Each span can contribute one wrapper class; pick the first
      // semantic class. api.bible only emits single-class spans.
      const cls = el.classList.value[0] ?? '';
      wrappers.push(cls);
      for (const c of el.childNodes) walk(c, wrappers);
      wrappers.pop();
    }
  }

  for (const n of nodes) walk(n, []);
  emit();
  return out;
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function wrap(text: string, wrappers: string[]): string {
  let out = escapeHtml(text);
  // Wrap from innermost to outermost so the first pushed wrapper is the
  // outermost in the emitted HTML.
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const cls = wrappers[i]!;
    if (cls.length > 0) out = `<span class="${cls}">${out}</span>`;
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function applyAnnotations(
  tokens: string[],
  annotations: { wordIndex: number; kind: 'bold' | 'italic' | 'boldItalic' }[],
): string[] {
  const result = [...tokens];
  for (const a of annotations) {
    if (a.wordIndex < 0 || a.wordIndex >= result.length) continue;
    const t = result[a.wordIndex]!;
    if (a.kind === 'bold') result[a.wordIndex] = `<b>${t}</b>`;
    else if (a.kind === 'italic') result[a.wordIndex] = `<i>${t}</i>`;
    else result[a.wordIndex] = `<b><i>${t}</i></b>`;
  }
  return result;
}

export function splitIntoPhrases(tokens: string[], counts: number[]): string[] {
  const result: string[] = [];
  let i = 0;
  for (const c of counts) {
    result.push(tokens.slice(i, i + c).join(' '));
    i += c;
  }
  return result;
}

/** Used in the token-count-mismatch fallback path: split tokens into
 *  approximately the right number of phrases, dropping annotations. */
function approximatePhrases(tokens: string[], counts: number[]): string[] {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const result: string[] = [];
  let i = 0;
  for (const c of counts) {
    const slice = Math.round((c / total) * tokens.length);
    result.push(tokens.slice(i, i + slice).join(' '));
    i += slice;
  }
  // Fold any leftover tokens into the last phrase so nothing's dropped.
  if (i < tokens.length && result.length > 0) {
    const last = result.length - 1;
    const tail = tokens.slice(i).join(' ');
    result[last] = result[last]!.length > 0 ? `${result[last]} ${tail}` : tail;
  }
  return result;
}

export function resolveHeadingTitle(
  heading: HeadingRangeInput,
  book: string,
  sections: Section[],
): string | null {
  const target = `${bookCodeOf(book)}.${heading.startChapter}.${heading.startVerse}`;
  const found = sections.find((s) => s.firstVerseId === target);
  return found?.title ?? null;
}
