import type { WasmEngine } from 'verse-vault-wasm';

import { type CardRef, cardRefKey } from './export-format.js';

/**
 * Bidirectional index between live `cardId`s and snapshot-stable
 * `CardRef`s.
 *
 * Built once per (user, material) by walking `engine.all_card_renders()`
 * — the same JSON the bulk-renders route returns. We re-translate the
 * flattened `CardKindWire` JSON back into the `CardRef` shape: most
 * fields pass through unchanged; HP/CCL discard the synthetic
 * `verseId` in favour of natural keys (`headingIdx` for HP,
 * `(book, chapter, tier)` for CCL) because those keys are stable
 * across builder runs while pseudo-verse ids are not portable across
 * materials.
 *
 * The `byRef` map uses `cardRefKey(ref)` (a canonical string) for
 * O(1) resolution.
 */
export interface CardRefIndex {
  byCardId: Map<number, CardRef>;
  byRef: Map<string, number>;
}

/** Subset of `CardRenderWire` we actually need to build the index.
 *  Decoded from `all_card_renders()` JSON; extra fields are ignored. */
interface CardRenderWire {
  cardId: number;
  verseId: number;
  kind: string;
  // CardKindWire fields are flattened into the same object:
  position?: number;
  headingIdx?: number;
  tier?: 'Club150' | 'Club300' | 'Full';
  withCitation?: boolean;
  verse: { book: string; chapter: number };
}

export function buildCardRefIndex(engine: WasmEngine): CardRefIndex {
  const renders = JSON.parse(engine.all_card_renders()) as CardRenderWire[];
  const byCardId = new Map<number, CardRef>();
  const byRef = new Map<string, number>();
  for (const c of renders) {
    const ref = toCardRef(c);
    if (!ref) continue;
    byCardId.set(c.cardId, ref);
    byRef.set(cardRefKey(ref), c.cardId);
  }
  return { byCardId, byRef };
}

/** Translate one `CardRenderWire` to a `CardRef`. Returns `undefined`
 *  on an unrecognised kind so a future core-side addition doesn't
 *  crash the resolver — the entry just won't appear in either map. */
function toCardRef(c: CardRenderWire): CardRef | undefined {
  switch (c.kind) {
    case 'PhraseFill':
      if (c.position === undefined) return undefined;
      return { kind: 'PhraseFill', verseId: c.verseId, position: c.position };
    case 'VerseAtVerseRef':
    case 'VerseInChapter':
    case 'VerseInBook':
    case 'Recitation':
    case 'Citation':
    case 'Reading':
      return { kind: c.kind, verseId: c.verseId };
    case 'VerseInHeading':
      if (c.headingIdx === undefined) return undefined;
      return { kind: 'VerseInHeading', verseId: c.verseId, headingIdx: c.headingIdx };
    case 'VerseInClub':
      if (!c.tier) return undefined;
      return { kind: 'VerseInClub', verseId: c.verseId, tier: c.tier };
    case 'Ftv':
      if (c.withCitation === undefined) return undefined;
      return { kind: 'Ftv', verseId: c.verseId, withCitation: c.withCitation };
    case 'HeadingPassage':
      if (c.headingIdx === undefined) return undefined;
      return { kind: 'HeadingPassage', headingIdx: c.headingIdx };
    case 'ChapterClubList':
      if (!c.tier) return undefined;
      return {
        kind: 'ChapterClubList',
        book: c.verse.book,
        chapter: c.verse.chapter,
        tier: c.tier,
      };
    default:
      return undefined;
  }
}

/** Resolve a CardRef to a live cardId via the index. Returns
 *  `undefined` when the importing snapshot doesn't have a matching
 *  card (e.g. an `Ftv` ref when the importing user has `ftv: false`
 *  so no FTV cards are emitted). The caller counts unresolved refs
 *  in the import summary. */
export function resolveCardRef(index: CardRefIndex, ref: CardRef): number | undefined {
  return index.byRef.get(cardRefKey(ref));
}
