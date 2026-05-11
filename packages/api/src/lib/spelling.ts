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

/** US (NKJV canonical) → Canadian spellings. Each entry is a complete
 *  word form — inflected forms (plurals, past tense) need their own
 *  entries because the regex matches whole tokens, not stems.
 *
 *  Could move to ``spelling.toml`` if the dict grows past ~200 entries;
 *  for now keeping it as TS source is simpler (no parser dep, native
 *  type-checking, single-file diff). */
const US_TO_CA: Record<string, string> = {
  // -or → -our  (Canadian follows British here)
  color: 'colour',
  colors: 'colours',
  colored: 'coloured',
  coloring: 'colouring',
  honor: 'honour',
  honors: 'honours',
  honored: 'honoured',
  honoring: 'honouring',
  honorable: 'honourable',
  labor: 'labour',
  labors: 'labours',
  labored: 'laboured',
  laboring: 'labouring',
  favor: 'favour',
  favors: 'favours',
  favored: 'favoured',
  favoring: 'favouring',
  favorable: 'favourable',
  favorite: 'favourite',
  favorites: 'favourites',
  neighbor: 'neighbour',
  neighbors: 'neighbours',
  neighboring: 'neighbouring',
  neighborhood: 'neighbourhood',
  savior: 'saviour',
  saviors: 'saviours',
  behavior: 'behaviour',
  behaviors: 'behaviours',
  savor: 'savour',
  savors: 'savours',
  savored: 'savoured',
  savory: 'savoury',
  vapor: 'vapour',
  vapors: 'vapours',
  splendor: 'splendour',
  harbor: 'harbour',
  harbors: 'harbours',
  harbored: 'harboured',
  harboring: 'harbouring',
  vigor: 'vigour',
  fervor: 'fervour',
  rumor: 'rumour',
  rumors: 'rumours',
  endeavor: 'endeavour',
  endeavors: 'endeavours',
  endeavored: 'endeavoured',
  endeavoring: 'endeavouring',
  humor: 'humour',
  humors: 'humours',
  humored: 'humoured',
  ardor: 'ardour',
  candor: 'candour',
  valor: 'valour',
  demeanor: 'demeanour',
  clamor: 'clamour',
  clamored: 'clamoured',
  flavor: 'flavour',
  flavors: 'flavours',
  flavored: 'flavoured',
  flavoring: 'flavouring',
  odor: 'odour',
  odors: 'odours',
  rigor: 'rigour',
  rigors: 'rigours',
  arbor: 'arbour',

  // -ense → -ence (Canadian uses British noun spellings)
  defense: 'defence',
  defenses: 'defences',
  offense: 'offence',
  offenses: 'offences',
  pretense: 'pretence',
  pretenses: 'pretences',

  // Doubled consonants on inflected verbs (-l → -ll before suffix)
  traveled: 'travelled',
  traveling: 'travelling',
  traveler: 'traveller',
  travelers: 'travellers',
  counseled: 'counselled',
  counseling: 'counselling',
  counselor: 'counsellor',
  counselors: 'counsellors',
  modeled: 'modelled',
  modeling: 'modelling',
  labeled: 'labelled',
  labeling: 'labelling',
  totaled: 'totalled',
  totaling: 'totalling',
  canceled: 'cancelled',
  canceling: 'cancelling',
  fueled: 'fuelled',
  fueling: 'fuelling',
  channeled: 'channelled',
  channeling: 'channelling',
  signaled: 'signalled',
  signaling: 'signalling',
  quarreled: 'quarrelled',
  quarreling: 'quarrelling',
  marveled: 'marvelled',
  marveling: 'marvelling',
  marvelous: 'marvellous',
  jeweled: 'jewelled',
  leveled: 'levelled',
  leveling: 'levelling',

  // Other
  gray: 'grey',
  grays: 'greys',
  mold: 'mould',
  molds: 'moulds',
  molded: 'moulded',
  moldy: 'mouldy',
  plow: 'plough',
  plows: 'ploughs',
  plowed: 'ploughed',

  // Deliberately NOT included (this Canadian flavour keeps American):
  //   baptize, realize, recognize, organize, emphasize (-ize verbs)
  //   center, fiber, theater (-er endings — user preference)
  //   curb, tire, aluminum (Canadian uses American here)
  //   practice/practise, license/licence (context-dependent noun/verb)
};

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
