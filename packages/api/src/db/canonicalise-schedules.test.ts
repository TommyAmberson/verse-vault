import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type SchedulePayloadV2, migrateSchedule, validateSchedule } from '../lib/schedules.js';
import { V1_SCHEDULE } from '../test-fixtures.js';
import { type TestDb, applyMigration, createTestDb, createTestUser } from '../test-utils.js';

import * as schema from './schema.js';

const MATERIAL_ID = 'nkjv-cor';
const PASSAGE = { book: '1 Corinthians', chapter: 2, startVerse: 1, endVerse: 5 };

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

  it('produces exactly what the TS fold produces', () => {
    // The case for a fourth copy of the fold living in SQL is that it
    // agrees with the canonical one. Assert that directly rather than
    // spot-checking hand-copied literals: an edit to `migrateV1Week` the
    // SQL doesn't mirror fails here.
    seed('u1', V1_SCHEDULE);
    backfill();
    expect(JSON.parse(stored('u1'))).toEqual(migrateSchedule(V1_SCHEDULE));
  });

  it('folds v1 weeks into blocks[] and drops the legacy keys', () => {
    seed('u1', V1_SCHEDULE);
    backfill();

    const out = JSON.parse(stored('u1')) as SchedulePayloadV2;
    expect(out.version).toBe(2);
    expect(out.weeks[0]!.blocks).toHaveLength(1);
    expect(out.weeks[0]!.blocks[0]!.passage.endVerse).toBe(31);
    expect(out.weeks[0]!.blocks[0]!.verses.club150).toEqual([5, 10]);
    expect(out.weeks[0]).not.toHaveProperty('passage');
    expect(out.weeks[0]).not.toHaveProperty('verses');
    // Review week with no passage folds to no blocks, same as the reader.
    expect(out.weeks[1]!.blocks).toEqual([]);
    expect(out.weeks[1]!.isReview).toBe(true);
    // The rewritten row has to survive the same validator a PUT body does.
    expect(() => validateSchedule(stored('u1'))).not.toThrow();
  });

  it('keeps a passage carried by a review week, matching the reader fold', () => {
    const payload = {
      ...V1_SCHEDULE,
      weeks: [{ date: '2025-11-17', passage: PASSAGE, isReview: true }],
    };
    seed('u1', payload);
    backfill();

    const out = JSON.parse(stored('u1')) as SchedulePayloadV2;
    expect(out).toEqual(migrateSchedule(payload));
    expect(out.weeks[0]!.isReview).toBe(true);
    expect(out.weeks[0]!.blocks).toHaveLength(1);
    // `verses` was absent on the v1 week; the fold supplies empty lists
    // rather than leaving the key off.
    expect(out.weeks[0]!.blocks[0]!.verses).toEqual({ club150: [], club300: [] });
  });

  it('prefers existing blocks over the legacy pair, as core does', () => {
    // Not emitted by any shipped client, but core's `ScheduleWeekRaw`
    // resolves it this way and the rewritten row is what the engine then
    // reads — a fold that picked the legacy pair here would delete the
    // blocks permanently.
    const payload = {
      ...V1_SCHEDULE,
      weeks: [
        {
          date: '2025-09-08',
          blocks: [{ passage: PASSAGE, verses: { club150: [3], club300: [] } }],
          passage: { book: 'Ignored', chapter: 9, startVerse: 9, endVerse: 9 },
          verses: { club150: [99], club300: [] },
          isReview: false,
        },
      ],
    };
    seed('u1', payload);
    backfill();

    const out = JSON.parse(stored('u1')) as SchedulePayloadV2;
    expect(out).toEqual(migrateSchedule(payload));
    expect(out.weeks[0]!.blocks).toHaveLength(1);
    expect(out.weeks[0]!.blocks[0]!.passage.book).toBe('1 Corinthians');
    expect(out.weeks[0]!.blocks[0]!.verses.club150).toEqual([3]);
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
      versesstring: { ...V1_SCHEDULE, weeks: [{ date: 'd', passage: PASSAGE, verses: 'club150' }] },
      blocksstring: { ...V1_SCHEDULE, weeks: [{ date: 'd', blocks: 'nope', passage: PASSAGE }] },
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
