import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateSchedule, validateSchedule } from '../lib/schedules.js';
import {
  REVIEW_WEEK_PASSAGE,
  V1_REVIEW_WEEK_WITH_PASSAGE,
  V1_SCHEDULE,
  V1_WEEK_WITH_BOTH_SHAPES,
} from '../test-schedules.js';
import { type TestDb, applyMigration, createTestDb, createTestUser } from '../test-utils.js';

import * as schema from './schema.js';

const MATERIAL_ID = 'nkjv-cor';

describe('0025_canonicalise_schedules', () => {
  let test: TestDb;
  beforeEach(() => {
    test = createTestDb();
  });
  afterEach(() => {
    test.cleanup();
  });

  function seed(userId: string, payload: unknown): void {
    createTestUser(test.db, userId);
    test.db
      .insert(schema.materialSchedules)
      .values({
        userId,
        materialId: MATERIAL_ID,
        scheduleJson: typeof payload === 'string' ? payload : JSON.stringify(payload),
        updatedAt: 1_700_000_000,
      })
      .run();
  }

  /** Raw column read — deliberately not `loadSchedule`, whose
   *  bundled-default fallback would mask a row the migration erased. */
  function stored(userId: string): string {
    return test.db
      .select({ scheduleJson: schema.materialSchedules.scheduleJson })
      .from(schema.materialSchedules)
      .where(eq(schema.materialSchedules.userId, userId))
      .get()!.scheduleJson;
  }

  function backfill(): void {
    applyMigration(test.path, '0025_canonicalise_schedules');
  }

  // The case for a fourth copy of the fold living in SQL is that it agrees
  // with the canonical one, so every fold case asserts equality with
  // `migrateSchedule` rather than spot-checking literals: an edit to
  // `migrateV1Week` the SQL doesn't mirror fails here. What each case
  // contributes is its payload — the semantics of the TS fold itself are
  // pinned in `lib/schedules.test.ts`, next to the code.
  it.for([
    ['a normal week and a review week', V1_SCHEDULE],
    ['a review week carrying a passage', V1_REVIEW_WEEK_WITH_PASSAGE],
    ['a week carrying both wire shapes', V1_WEEK_WITH_BOTH_SHAPES],
    // A non-array `blocks` is ignored rather than disqualifying, because
    // `migrateV1Week`'s `Array.isArray` ignores it too — the guard only
    // rejects what would actually break the fold.
    [
      'a week whose blocks is not an array',
      {
        ...V1_SCHEDULE,
        weeks: [{ date: '2025-09-08', blocks: 'nope', passage: REVIEW_WEEK_PASSAGE }],
      },
    ],
  ] as const)('folds %s exactly as the TS fold does', ([, payload]) => {
    seed('u1', payload);
    backfill();
    expect(JSON.parse(stored('u1'))).toEqual(migrateSchedule(payload));
    // The rewritten row also has to survive the validator a PUT body does.
    expect(() => validateSchedule(stored('u1'))).not.toThrow();
  });

  it('leaves a v2 row untouched and is idempotent', () => {
    seed('u1', migrateSchedule(V1_SCHEDULE));
    const before = stored('u1');
    backfill();
    expect(stored('u1')).toBe(before);

    // A second pass over a freshly-migrated v1 row is also a no-op.
    seed('u2', V1_SCHEDULE);
    backfill();
    const once = stored('u2');
    backfill();
    expect(stored('u2')).toBe(once);
  });

  it('skips rows it cannot safely rewrite instead of erasing them', () => {
    const rows: Record<string, unknown> = {
      invalid: 'not json at all',
      // Valid JSON, v1, but `weeks` isn't an array — `json_each` over it
      // yields nothing and `json_group_array` would erase the schedule.
      weeksnotarray: { ...V1_SCHEDULE, weeks: null },
      // A week that isn't an object: `json_each`'s `value` is raw text,
      // and feeding that back through `json_type` raises `malformed JSON`.
      weeknotobject: { ...V1_SCHEDULE, weeks: ['not a week'] },
      // Field types the fold can't consume. Each reached storage on a
      // released API: review weeks went unvalidated on PUT until 0.1.34,
      // and the route stored request bodies verbatim before that.
      passagestring: {
        ...V1_SCHEDULE,
        weeks: [{ date: 'd', passage: '1 Cor 2:1-5', isReview: true }],
      },
      versesstring: {
        ...V1_SCHEDULE,
        weeks: [{ date: 'd', passage: REVIEW_WEEK_PASSAGE, verses: 'club150' }],
      },
    };
    for (const [userId, payload] of Object.entries(rows)) seed(userId, payload);

    // One unconsumable row must not abort the statement. Drizzle records
    // nothing when a migration throws, so boot would die and retry the
    // same failure on every restart.
    expect(() => backfill()).not.toThrow();

    for (const [userId, payload] of Object.entries(rows)) {
      const expected = typeof payload === 'string' ? payload : JSON.stringify(payload);
      expect(stored(userId), `${userId} should be untouched`).toBe(expected);
    }
  });
});
