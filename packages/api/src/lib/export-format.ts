/**
 * Account export/import payload — JSON shape transferred between
 * `GET /api/export` and `POST /api/import`. Designed so a Python
 * converter (e.g. `tools/anki_to_export.py`) can produce the same
 * shape from a third-party source.
 *
 * Version contract: increment `exportVersion` (integer) on any
 * non-additive shape change. Adding optional fields is backwards-
 * compatible and does not require a bump. The importer rejects
 * unknown major versions with a 400.
 *
 * Stability: review events and graduations key on `CardRef` —
 * `(kind, verseId, params)` — not `cardId`. Card ids reshuffle when
 * the deck JSON changes; `CardRef` is the canonical identity the
 * engine materialises from at runtime via `engine.all_card_renders()`.
 * That means an export from snapshot version 5 can be imported into
 * snapshot version 7 as long as the referenced verses still exist.
 */

/** ClubTier wire form — matches `verse-vault-core::ClubTier` serde shape. */
export type ClubTierName = 'Club150' | 'Club300' | 'Full';

/** Identifies a card by its semantic position rather than its assigned
 *  `cardId`. The `kind` discriminator lines up 1:1 with `CardKindWire`
 *  in `crates/wasm/src/lib.rs`. Verse-bound kinds carry `verseId`;
 *  pseudo-verse kinds (`HeadingPassage`, `ChapterClubList`) omit it
 *  because their `verseId` is a synthetic builder-assigned value an
 *  external converter has no way to compute. The natural key
 *  (`headingIdx` for HP, `(book, chapter, tier)` for CCL) uniquely
 *  identifies the card to the resolver. */
export type CardRef =
  | { kind: 'PhraseFill'; verseId: number; position: number }
  | {
      kind:
        | 'VerseAtVerseRef'
        | 'VerseInChapter'
        | 'VerseInBook'
        | 'Recitation'
        | 'Citation'
        | 'Reading';
      verseId: number;
    }
  | { kind: 'VerseInHeading'; verseId: number; headingIdx: number }
  | { kind: 'VerseInClub'; verseId: number; tier: ClubTierName }
  | { kind: 'Ftv'; verseId: number; withCitation: boolean }
  | { kind: 'HeadingPassage'; headingIdx: number }
  | { kind: 'ChapterClubList'; book: string; chapter: number; tier: ClubTierName };

/** Per-(user, material) settings. Mirrors `user_year_settings` columns
 *  in camelCase so a new column added there propagates by re-running
 *  the export with the wider type.
 *
 *  Phase 1: `configJson` carries the per-club shape verbatim when the
 *  row has been migrated / re-written under the new flow. Older exports
 *  omit it (null when absent); the importer falls back to deriving the
 *  per-club shape from the flat columns via `legacyToNew`. */
export interface YearSettingsExport {
  headingCard: boolean;
  headingPassageCard: boolean;
  ftv: boolean;
  newScope: string;
  reviewScope: string;
  clubCardScope: string;
  chapterListScope: string;
  lessonBatchSize: number;
  desiredRetention: number;
  /** Phase 1+ — per-club MaterialConfig JSON string. Null on older
   *  exports; null on rows that haven't been touched since migration
   *  0023 (the engine path synthesises in that case). */
  configJson?: string | null;
  updatedAt: number;
}

/** Per-(user, material) memorize schedule override. `null` (or absent)
 *  when the user hasn't customised the bundled default. Exported and
 *  imported verbatim — the importer doesn't re-validate the body
 *  (the engine load path does on the next request). */
export interface ScheduleExport {
  scheduleJson: string;
  updatedAt: number;
}

export interface EnrollmentExport {
  clubTier: number | null;
  offlineMode: boolean;
  createdAt: number;
}

export interface MaterialSnapshotExport {
  /** Informational. The importer does NOT enforce a match — cardRefs
   *  resolve against the importing engine's current snapshot. */
  version: number;
  contentSha: string;
}

export interface ReviewEventExport {
  /** Stable, deterministic per source row (e.g. `anki:<col-mod>:<revlog-id>`
   *  for the Anki converter). The importer dedupes by this. */
  clientEventId: string;
  /** Unix seconds (not ms). */
  timestampSecs: number;
  cardRef: CardRef;
  /** FSRS grade in `1..=4` (Again/Hard/Good/Easy). */
  grade: 1 | 2 | 3 | 4;
}

export interface GraduatedVerseExport {
  verseId: number;
  graduatedAtSecs: number;
}

export interface GraduatedCardExport {
  cardRef: CardRef;
  graduatedAtSecs: number;
}

export interface MaterialExport {
  materialId: string;
  enrollment: EnrollmentExport;
  /** `null` when no `user_year_settings` row exists (user enrolled but
   *  never touched any setting). */
  settings: YearSettingsExport | null;
  /** Phase 1+ — `null` when the user hasn't customised the bundled
   *  default. Omitted (treated as null) on pre-Phase-1 exports. */
  schedule?: ScheduleExport | null;
  snapshot: MaterialSnapshotExport;
  graduatedVerses: GraduatedVerseExport[];
  graduatedCards: GraduatedCardExport[];
  reviewEvents: ReviewEventExport[];
}

export interface AccountExport {
  exportVersion: 1;
  /** Unix seconds at the moment the export was assembled. */
  exportedAt: number;
  user: { email: string; name: string };
  materials: MaterialExport[];
}

export interface ImportSummary {
  materialsApplied: number;
  eventsInserted: number;
  /** Events skipped because their `clientEventId` already existed for
   *  this user × material — the dedup path is what makes re-import
   *  idempotent. */
  eventsSkipped: number;
  graduationsApplied: number;
  /** Count of CardRefs that didn't match any card in the importing
   *  engine's current snapshot (e.g. `Ftv` in an export where the
   *  importing user has `ftv: false`). Skipped, not rejected. */
  unresolvedCardRefs: number;
}

/** Canonical key for the CardRef ↔ cardId index. Stable across
 *  process restarts because it's built from the CardRef shape, not
 *  from any in-memory pointer. Exported because both the export and
 *  import paths use the same indexer. */
export function cardRefKey(ref: CardRef): string {
  switch (ref.kind) {
    case 'PhraseFill':
      return `PhraseFill|${ref.verseId}|${ref.position}`;
    case 'VerseAtVerseRef':
    case 'VerseInChapter':
    case 'VerseInBook':
    case 'Recitation':
    case 'Citation':
    case 'Reading':
      return `${ref.kind}|${ref.verseId}`;
    case 'VerseInHeading':
      return `VerseInHeading|${ref.verseId}|${ref.headingIdx}`;
    case 'VerseInClub':
      return `VerseInClub|${ref.verseId}|${ref.tier}`;
    case 'Ftv':
      return `Ftv|${ref.verseId}|${ref.withCitation ? '1' : '0'}`;
    case 'HeadingPassage':
      return `HeadingPassage|${ref.headingIdx}`;
    case 'ChapterClubList':
      return `ChapterClubList|${ref.book}|${ref.chapter}|${ref.tier}`;
  }
}
