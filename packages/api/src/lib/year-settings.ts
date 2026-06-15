/**
 * Per-(user, material) year settings: the domain types, bounds, and
 * validation shared between the `PUT /api/years/:id/settings` route and
 * the account importer. Both write to `user_year_settings`, so both must
 * enforce the same field constraints — the importer can't trust an
 * uploaded payload any more than the route trusts a request body.
 */

export type TierScope = 'off' | 'up150' | 'up300' | 'all';
export type ChapterListScope = 'off' | 'up150' | 'up300';

export const TIER_SCOPES: readonly TierScope[] = ['off', 'up150', 'up300', 'all'];
// chapter_list_scope omits 'all' — Full never emits a chapter-list card.
export const CHAPTER_LIST_SCOPES: readonly ChapterListScope[] = ['off', 'up150', 'up300'];

export const DEFAULT_LESSON_BATCH_SIZE = 3;
const MIN_LESSON_BATCH_SIZE = 1;
const MAX_LESSON_BATCH_SIZE = 10;

// Legacy bounds used by the existing flat `YearSettings` validator.
// Pre-Phase-1 clients shipped retention values in this range; kept here
// so the route's accept-legacy-shape path doesn't reject what was
// previously valid (the per-club shape clamps separately on read).
const LEGACY_MIN_DESIRED_RETENTION = 0.7;
const LEGACY_MAX_DESIRED_RETENTION = 0.97;

// Phase 1 per-club retention bounds: tighter than the FSRS-author range.
// Quizzers don't push as high as long-term-retention apps; the Rust
// scheduler clamps to this range on read so out-of-range stored values
// never reach FSRS math.
export const MIN_DESIRED_RETENTION = 0.5;
export const MAX_DESIRED_RETENTION = 0.9;
export const DEFAULT_DESIRED_RETENTION = 0.8;

export interface YearSettings {
  headingCard: boolean;
  headingPassageCard: boolean;
  ftv: boolean;
  newScope: TierScope;
  reviewScope: TierScope;
  clubCardScope: TierScope;
  chapterListScope: ChapterListScope;
  lessonBatchSize: number;
  desiredRetention: number;
}

// === Phase 1 per-club shape (new) ============================================
//
// Mirrors `crates/core::material_config::MaterialConfig`'s JSON wire form.
// The route layer accepts EITHER `YearSettings` (legacy flat shape) or this
// `PerClubYearSettings` shape on the POST body; the importer's reader path
// accepts both too. Both shapes write to the DB: the legacy columns stay
// authoritative until Phase 2 drops them, but `config_json` is mirrored on
// every write so the engine path can read the per-club shape directly.

export type Club = 'club150' | 'club300' | 'full';
export type CatchUp = 'sequential' | 'calendarCascade';
export type MoveToNextGate =
  | 'fullyMemorized'
  | 'afterMajorCheckpoint'
  | 'afterMinorCheckpoint'
  | 'caughtUp'
  | 'always';

export const CATCH_UP_VALUES: readonly CatchUp[] = ['sequential', 'calendarCascade'];
export const MOVE_TO_NEXT_GATES: readonly MoveToNextGate[] = [
  'fullyMemorized',
  'afterMajorCheckpoint',
  'afterMinorCheckpoint',
  'caughtUp',
  'always',
];

export interface ClubMemorizeConfig {
  enabled: boolean;
  catchUp: CatchUp;
}

export interface ClubReviewConfig {
  enabled: boolean;
  /** Valid range `[0.5, 0.9]`. The engine clamps on read; we still
   *  reject out-of-range values at the boundary so the DB stays clean. */
  desiredRetention: number;
}

export interface ClubMemorizeMap {
  club150: ClubMemorizeConfig;
  club300: ClubMemorizeConfig;
  full: ClubMemorizeConfig;
}

export interface ClubReviewMap {
  club150: ClubReviewConfig;
  club300: ClubReviewConfig;
  full: ClubReviewConfig;
}

export interface MoveToNextConfig {
  p150To300: MoveToNextGate;
  p300ToFull: MoveToNextGate;
}

export interface PerClubYearSettings {
  headingCard: boolean;
  headingPassageCard: boolean;
  ftv: boolean;
  clubCardScope: TierScope;
  chapterListScope: ChapterListScope;
  memorize: ClubMemorizeMap;
  review: ClubReviewMap;
  moveToNext: MoveToNextConfig;
  lessonBatchSize: number;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function ensureBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`);
  }
  return value;
}

export function ensureBatchSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError('lessonBatchSize must be an integer');
  }
  if (value < MIN_LESSON_BATCH_SIZE || value > MAX_LESSON_BATCH_SIZE) {
    throw new ValidationError(
      `lessonBatchSize must be between ${MIN_LESSON_BATCH_SIZE} and ${MAX_LESSON_BATCH_SIZE}`,
    );
  }
  return value;
}

export function ensureRetention(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('desiredRetention must be a number');
  }
  if (value < LEGACY_MIN_DESIRED_RETENTION || value > LEGACY_MAX_DESIRED_RETENTION) {
    throw new ValidationError(
      `desiredRetention must be between ${LEGACY_MIN_DESIRED_RETENTION} and ${LEGACY_MAX_DESIRED_RETENTION}`,
    );
  }
  return value;
}

export function ensureEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Validate a full settings object (every field required), returning a
 *  clean `YearSettings`. Throws `ValidationError` on the first bad
 *  field. Used by the importer, where the whole row arrives at once;
 *  the route's PATCH path validates field-by-field for partial bodies. */
export function validateYearSettings(raw: {
  headingCard: unknown;
  headingPassageCard: unknown;
  ftv: unknown;
  newScope: unknown;
  reviewScope: unknown;
  clubCardScope: unknown;
  chapterListScope: unknown;
  lessonBatchSize: unknown;
  desiredRetention: unknown;
}): YearSettings {
  return {
    headingCard: ensureBoolean(raw.headingCard, 'headingCard'),
    headingPassageCard: ensureBoolean(raw.headingPassageCard, 'headingPassageCard'),
    ftv: ensureBoolean(raw.ftv, 'ftv'),
    newScope: ensureEnum(raw.newScope, 'newScope', TIER_SCOPES),
    reviewScope: ensureEnum(raw.reviewScope, 'reviewScope', TIER_SCOPES),
    clubCardScope: ensureEnum(raw.clubCardScope, 'clubCardScope', TIER_SCOPES),
    chapterListScope: ensureEnum(raw.chapterListScope, 'chapterListScope', CHAPTER_LIST_SCOPES),
    lessonBatchSize: ensureBatchSize(raw.lessonBatchSize),
    desiredRetention: ensureRetention(raw.desiredRetention),
  };
}

// === Phase 1 helpers ========================================================

function clampRetention(value: number): number {
  if (value < MIN_DESIRED_RETENTION) return MIN_DESIRED_RETENTION;
  if (value > MAX_DESIRED_RETENTION) return MAX_DESIRED_RETENTION;
  return value;
}

function memorizeFromScope(scope: TierScope): ClubMemorizeMap {
  return {
    club150: { enabled: scope === 'up150' || scope === 'up300' || scope === 'all', catchUp: 'sequential' },
    club300: { enabled: scope === 'up300' || scope === 'all', catchUp: 'sequential' },
    full: { enabled: scope === 'all', catchUp: 'sequential' },
  };
}

function reviewFromScope(scope: TierScope, retention: number): ClubReviewMap {
  const r = clampRetention(retention);
  return {
    club150: { enabled: scope === 'up150' || scope === 'up300' || scope === 'all', desiredRetention: r },
    club300: { enabled: scope === 'up300' || scope === 'all', desiredRetention: r },
    full: { enabled: scope === 'all', desiredRetention: r },
  };
}

/** Convert the legacy flat `YearSettings` shape into the per-club
 *  shape per the spec's migration table. Used by:
 *
 *    * the POST settings route's accept-old-shape branch,
 *    * the importer's read path when an old-shape export comes in,
 *    * `readMaterialConfigJson` when `config_json` is NULL.
 *
 *  Retention values above `MAX_DESIRED_RETENTION` (a common pre-Phase 1
 *  preference of 0.95) clamp to 0.9; below `MIN_DESIRED_RETENTION` clamp
 *  to 0.5. Catch-up defaults to Sequential on every club, and the
 *  cross-club gates default to CaughtUp on every pair. */
export function legacyToNew(old: YearSettings): PerClubYearSettings {
  return {
    headingCard: old.headingCard,
    headingPassageCard: old.headingPassageCard,
    ftv: old.ftv,
    clubCardScope: old.clubCardScope,
    chapterListScope: old.chapterListScope,
    memorize: memorizeFromScope(old.newScope),
    review: reviewFromScope(old.reviewScope, old.desiredRetention),
    moveToNext: { p150To300: 'caughtUp', p300ToFull: 'caughtUp' },
    lessonBatchSize: old.lessonBatchSize,
  };
}

/** Per-club retention validator. Tighter range than the legacy
 *  `ensureRetention`: bounded to `[0.5, 0.9]`. */
export function ensureClubRetention(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a number`);
  }
  if (value < MIN_DESIRED_RETENTION || value > MAX_DESIRED_RETENTION) {
    throw new ValidationError(
      `${field} must be between ${MIN_DESIRED_RETENTION} and ${MAX_DESIRED_RETENTION}`,
    );
  }
  return value;
}

export function ensureCatchUp(value: unknown, field: string): CatchUp {
  return ensureEnum(value, field, CATCH_UP_VALUES);
}

export function ensureGate(value: unknown, field: string): MoveToNextGate {
  return ensureEnum(value, field, MOVE_TO_NEXT_GATES);
}

function ensureClubMemorizeConfig(value: unknown, field: string): ClubMemorizeConfig {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`${field} must be an object`);
  }
  const o = value as Record<string, unknown>;
  return {
    enabled: ensureBoolean(o.enabled, `${field}.enabled`),
    catchUp: ensureCatchUp(o.catchUp, `${field}.catchUp`),
  };
}

function ensureClubReviewConfig(value: unknown, field: string): ClubReviewConfig {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`${field} must be an object`);
  }
  const o = value as Record<string, unknown>;
  return {
    enabled: ensureBoolean(o.enabled, `${field}.enabled`),
    desiredRetention: ensureClubRetention(o.desiredRetention, `${field}.desiredRetention`),
  };
}

/** Validate a per-club settings object (every field required), returning
 *  a clean `PerClubYearSettings`. Symmetric to `validateYearSettings`. */
export function validatePerClubYearSettings(raw: {
  headingCard: unknown;
  headingPassageCard: unknown;
  ftv: unknown;
  clubCardScope: unknown;
  chapterListScope: unknown;
  memorize: unknown;
  review: unknown;
  moveToNext: unknown;
  lessonBatchSize: unknown;
}): PerClubYearSettings {
  if (typeof raw.memorize !== 'object' || raw.memorize === null) {
    throw new ValidationError('memorize must be an object');
  }
  if (typeof raw.review !== 'object' || raw.review === null) {
    throw new ValidationError('review must be an object');
  }
  if (typeof raw.moveToNext !== 'object' || raw.moveToNext === null) {
    throw new ValidationError('moveToNext must be an object');
  }
  const memorizeRaw = raw.memorize as Record<string, unknown>;
  const reviewRaw = raw.review as Record<string, unknown>;
  const moveRaw = raw.moveToNext as Record<string, unknown>;
  return {
    headingCard: ensureBoolean(raw.headingCard, 'headingCard'),
    headingPassageCard: ensureBoolean(raw.headingPassageCard, 'headingPassageCard'),
    ftv: ensureBoolean(raw.ftv, 'ftv'),
    clubCardScope: ensureEnum(raw.clubCardScope, 'clubCardScope', TIER_SCOPES),
    chapterListScope: ensureEnum(raw.chapterListScope, 'chapterListScope', CHAPTER_LIST_SCOPES),
    memorize: {
      club150: ensureClubMemorizeConfig(memorizeRaw.club150, 'memorize.club150'),
      club300: ensureClubMemorizeConfig(memorizeRaw.club300, 'memorize.club300'),
      full: ensureClubMemorizeConfig(memorizeRaw.full, 'memorize.full'),
    },
    review: {
      club150: ensureClubReviewConfig(reviewRaw.club150, 'review.club150'),
      club300: ensureClubReviewConfig(reviewRaw.club300, 'review.club300'),
      full: ensureClubReviewConfig(reviewRaw.full, 'review.full'),
    },
    moveToNext: {
      p150To300: ensureGate(moveRaw.p150To300, 'moveToNext.p150To300'),
      p300ToFull: ensureGate(moveRaw.p300ToFull, 'moveToNext.p300ToFull'),
    },
    lessonBatchSize: ensureBatchSize(raw.lessonBatchSize),
  };
}

/** Heuristic: does the payload look like the new per-club shape? True
 *  if it has either a `memorize` object or a `review` object (the two
 *  required top-level fields unique to PerClubYearSettings). Used by
 *  the route's accept-either-shape branch. */
export function looksLikePerClub(raw: Record<string, unknown>): boolean {
  return (
    (typeof raw.memorize === 'object' && raw.memorize !== null)
    || (typeof raw.review === 'object' && raw.review !== null)
  );
}

/** Highest enabled tier in a per-club map collapses to a cumulative
 *  TierScope. Lossy when an intermediate tier is enabled without its
 *  predecessor — but that's a per-club-shape-only configuration that
 *  the legacy columns can't represent anyway. */
function highestEnabledScope(m: { club150: { enabled: boolean }; club300: { enabled: boolean }; full: { enabled: boolean } }): TierScope {
  if (m.full.enabled) return 'all';
  if (m.club300.enabled) return 'up300';
  if (m.club150.enabled) return 'up150';
  return 'off';
}

/** Derive a legacy `YearSettings` from the new per-club shape, lossy on
 *  the scope ladders (see `highestEnabledScope`). Retention picks the
 *  Club 150 value (the user's primary tier) or falls back to the
 *  per-club default. The legacy columns aren't engine-load-driving as
 *  of commit 8 of the Phase 1 train — they're written as a mirror so
 *  importers and pre-Phase-2 clients keep reading sensible defaults. */
export function perClubToLegacy(p: PerClubYearSettings): YearSettings {
  return {
    headingCard: p.headingCard,
    headingPassageCard: p.headingPassageCard,
    ftv: p.ftv,
    newScope: highestEnabledScope(p.memorize),
    reviewScope: highestEnabledScope(p.review),
    clubCardScope: p.clubCardScope,
    chapterListScope: p.chapterListScope,
    lessonBatchSize: p.lessonBatchSize,
    desiredRetention: p.review.club150.desiredRetention,
  };
}
