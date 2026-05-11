/**
 * US → Canadian spelling substitution for NKJV display text.
 *
 * api.bible returns American spelling (NKJV is published by Thomas Nelson,
 * a US publisher). The user's flavour of Canadian English mixes British
 * and American conventions:
 *   - ``-our`` endings (British): colour, honour, labour, neighbour …
 *   - ``-ence`` noun endings (British): defence, offence …
 *   - ``-er`` endings (American — NOT British ``-re``): center, fiber,
 *     theater stay as-is, NOT ``centre`` etc.
 *   - ``-ize`` verb endings (American — NOT British ``-ise``):
 *     baptize, realize, recognize stay as-is, NOT ``baptise`` etc.
 *
 * Substitutions are intentionally narrow — only pairs where the
 * Canadian variant is the unambiguous equivalent. Context-dependent
 * pairs like ``practice``/``practise`` (noun vs verb in CA/UK) and
 * ``license``/``licence`` are omitted; a blind swap would corrupt
 * legitimate uses.
 *
 * Word boundaries and capitalisation are preserved:
 *   - ``labor``  → ``labour``
 *   - ``Labor``  → ``Labour``
 *   - ``LABOR``  → ``LABOUR``
 *   - ``labors`` → matched only because the plural is in the map;
 *     partial stem matches are not made.
 *
 * HTML tags pass through untouched because the regex matches only word
 * characters; ``<b>`` and ``</b>`` don't form word matches.
 */

export type Dialect = 'canadian' | 'american';

export const DEFAULT_DIALECT: Dialect = 'canadian';

/** Substitution dict from the ``varcon`` npm package's pre-built
 *  ``C.json`` (Canadian-primary variants of GNU Aspell's VarCon table).
 *  Inversion is one-shot at module load: for every Canadian word ``c``,
 *  its variant map gives the equivalent American / British / OED form,
 *  and we record each non-Canadian variant → ``c`` so any input form
 *  normalises to the Canadian primary.
 *
 *  varcon's compile.js falls back through ``C → Z → B`` so Canadian
 *  inherits OED ``-ize`` endings when there's no explicit ``C`` tag.
 *  That's why baptize / realize / recognize pass through unchanged —
 *  the package treats them as already-Canadian, no substitution
 *  needed.
 *
 *  Refresh by bumping the ``varcon`` version in ``package.json``. */
import varconC from 'varcon/C.json' with { type: 'json' };

interface VarconVariants {
  A?: string;
  B?: string;
  Z?: string;
}

const US_TO_CA: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [canadian, variants] of Object.entries(varconC as Record<string, VarconVariants>)) {
    if (canadian.includes(' ')) continue; // multi-word phrases can't word-boundary match
    for (const variant of Object.values(variants)) {
      if (typeof variant === 'string' && variant !== canadian && !variant.includes(' ')) {
        out[variant] = canadian;
      }
    }
  }
  return out;
})();

const WORD_RE = /\b[A-Za-z]+\b/g;

/** Apply US → Canadian substitution, preserving capitalisation. */
export function toCanadian(text: string): string {
  return text.replace(WORD_RE, (word) => {
    const lower = word.toLowerCase();
    const replacement = US_TO_CA[lower];
    if (!replacement) return word;
    return matchCase(word, replacement);
  });
}

/** Apply the active dialect to text. ``american`` is a no-op since the
 *  source (api.bible NKJV) is already American. */
export function applyDialect(text: string, dialect: Dialect): string {
  return dialect === 'canadian' ? toCanadian(text) : text;
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
