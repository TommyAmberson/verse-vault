/**
 * Apply a spelling dialect to NKJV display text.
 *
 * api.bible returns American spelling (NKJV is published by Thomas Nelson,
 * a US publisher). VarCon's ``A.json`` maps each American word to its
 * equivalents in other dialects; we use it to substitute on render.
 *
 * Supported dialects:
 *   - ``american`` — pass-through; source already matches.
 *   - ``british`` — A → B (``-our`` endings, ``-ence`` nouns, ``-ise``
 *     verbs, ``-re`` endings, doubled-consonant inflections).
 *   - ``canadian`` — A → C. Canadian inherits British where it differs
 *     from American (``-our``, ``-ence``, ``-re``, doubled consonants)
 *     but stays with American on ``-ize`` verbs (baptize, realize,
 *     recognize) and agent-noun ``-or`` words (governor, emperor).
 *
 * Word boundaries and capitalisation are preserved:
 *   - ``labor``  → ``labour``
 *   - ``Labor``  → ``Labour``
 *   - ``LABOR``  → ``LABOUR``
 *
 * HTML tags pass through untouched because the regex matches only word
 * characters; ``<b>`` and ``</b>`` don't form word matches.
 */

export type Dialect = 'american' | 'british' | 'canadian';

export const DEFAULT_DIALECT: Dialect = 'canadian';

/** A.json from the ``varcon`` npm package: American canonical key →
 *  ``{B, C}`` variants. api.bible NKJV ships American, so this is the
 *  natural source side. Refresh by bumping ``varcon`` in package.json. */
import varconA from 'varcon/A.json' with { type: 'json' };

interface VarconVariants {
  B?: string;
  C?: string;
}

type TargetDialect = Exclude<Dialect, 'american'>;

const VARCON_KEY: Record<TargetDialect, 'B' | 'C'> = {
  british: 'B',
  canadian: 'C',
};

function buildDict(key: 'B' | 'C'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [american, variants] of Object.entries(varconA as Record<string, VarconVariants>)) {
    if (american.includes(' ')) continue; // multi-word phrases can't word-boundary match
    const target = variants[key];
    if (typeof target === 'string' && target !== american && !target.includes(' ')) {
      out[american.toLowerCase()] = target;
    }
  }
  return out;
}

const SUB_DICTS: Record<TargetDialect, Record<string, string>> = {
  british: buildDict('B'),
  canadian: buildDict('C'),
};

const WORD_RE = /\b[A-Za-z]+\b/g;

/** Substitute American spellings for the target dialect's forms,
 *  preserving capitalisation. ``american`` is a no-op since the
 *  source (api.bible NKJV) is already American. */
export function applyDialect(text: string, dialect: Dialect): string {
  if (dialect === 'american') return text;
  const dict = SUB_DICTS[dialect];
  return text.replace(WORD_RE, (word) => {
    const replacement = dict[word.toLowerCase()];
    if (!replacement) return word;
    return matchCase(word, replacement);
  });
}

/** Convenience alias: ``applyDialect(text, 'canadian')``. */
export function toCanadian(text: string): string {
  return applyDialect(text, 'canadian');
}

/** Preserve the casing pattern of ``source`` on ``replacement``:
 *   - all upper → all upper
 *   - leading capital → leading capital
 *   - all other patterns → lower (the dict stores lowercase). */
function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source[0] === source[0]!.toUpperCase()) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
