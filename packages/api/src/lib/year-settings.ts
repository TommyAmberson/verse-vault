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

// FSRS-author recommended bounds: below 0.7 lets too much fade between
// reviews; above 0.97 explodes review count for marginal recall gains.
const MIN_DESIRED_RETENTION = 0.7;
const MAX_DESIRED_RETENTION = 0.97;

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
  if (value < MIN_DESIRED_RETENTION || value > MAX_DESIRED_RETENTION) {
    throw new ValidationError(
      `desiredRetention must be between ${MIN_DESIRED_RETENTION} and ${MAX_DESIRED_RETENTION}`,
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
