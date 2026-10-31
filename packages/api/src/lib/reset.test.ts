import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestDb } from '../test-utils.js';

import { EngineStore } from './engine.js';
import { take } from './pending-events.js';
import { deleteAccountProgress, resetAccount } from './reset.js';

const MATERIAL_ID = 'nkjv-cor';
const NOW = 1_700_000_000;

function seedProgress(db: ReturnType<typeof createTestDb>['db']) {
  // Enrolls u1 (seeds user_materials, graph_snapshot, test_states) and
  // gives us settings + events + graduations to wipe.
  seedUserWithFixture({ db, userId: 'u1', materialId: MATERIAL_ID });
  db.insert(schema.userYearSettings)
    .values({
      userId: 'u1',
      materialId: MATERIAL_ID,
      headingCard: true,
      headingPassageCard: true,
      ftv: true,
      newScope: 'all',
      reviewScope: 'all',
      clubCardScope: 'off',
      chapterListScope: 'up150',
      lessonBatchSize: 3,
      desiredRetention: 0.9,
      updatedAt: NOW,
    })
    .run();
  db.insert(schema.reviewEvents)
    .values([
      {
        id: 'e1',
        userId: 'u1',
        materialId: MATERIAL_ID,
        snapshotVersion: 1,
        timestampSecs: NOW,
        cardId: 0,
        grade: 3,
        clientEventId: 'e1',
        createdAt: NOW,
      },
      {
        id: 'e2',
        userId: 'u1',
        materialId: MATERIAL_ID,
        snapshotVersion: 1,
        timestampSecs: NOW + 1,
        cardId: 0,
        grade: 4,
        clientEventId: 'e2',
        createdAt: NOW + 1,
      },
    ])
    .run();
  db.insert(schema.graduatedVerses)
    .values({ userId: 'u1', materialId: MATERIAL_ID, verseId: 0, graduatedAtSecs: NOW })
    .run();
  db.insert(schema.graduatedCards)
    .values({ userId: 'u1', materialId: MATERIAL_ID, cardId: 0, graduatedAtSecs: NOW })
    .run();
  // Held events: one for the enrolled material, one for a material the
  // account never enrolled in.
  for (const materialId of [MATERIAL_ID, 'never-enrolled']) {
    take(db, { userId: 'u1', materialId }, [
      {
        clientEventId: `held-${materialId}`,
        kind: 'review',
        timestampSecs: NOW,
        payload: {},
        status: 'pending',
        reasonCode: 'card-not-emitted',
        reason: 'test',
      },
    ], NOW);
  }
}

describe('deleteAccountProgress', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('wipes learning state but keeps enrollment + settings', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedProgress(test.db);

    const engines = new EngineStore(test.db);
    try {
      const summary = await deleteAccountProgress(test.db, engines, 'u1');

      expect(summary.materialsReset).toBe(1);
      expect(summary.eventsDeleted).toBe(2);
      expect(summary.graduationsDeleted).toBe(2);

      expect(test.db.select().from(schema.reviewEvents).all()).toHaveLength(0);
      expect(test.db.select().from(schema.graduatedVerses).all()).toHaveLength(0);
      expect(test.db.select().from(schema.graduatedCards).all()).toHaveLength(0);
      expect(test.db.select().from(schema.testStates).all()).toHaveLength(0);
      expect(test.db.select().from(schema.pendingEvents).all()).toHaveLength(0);

      // Enrollment + settings survive — decks stay, just reset to new.
      expect(test.db.select().from(schema.userMaterials).all()).toHaveLength(1);
      expect(test.db.select().from(schema.userYearSettings).all()).toHaveLength(1);
    } finally {
      engines.clear();
    }
  });

  it('is idempotent: a second call returns zeros', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedProgress(test.db);

    const engines = new EngineStore(test.db);
    try {
      await deleteAccountProgress(test.db, engines, 'u1');
      const second = await deleteAccountProgress(test.db, engines, 'u1');
      expect(second).toEqual({ materialsReset: 0, eventsDeleted: 0, graduationsDeleted: 0 });
    } finally {
      engines.clear();
    }
  });
});

describe('resetAccount', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('clears writes that were waiting on a deck it reset', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedProgress(test.db);

    const engines = new EngineStore(test.db);
    try {
      const key = { userId: 'u1', materialId: MATERIAL_ID };
      const graduate = (verseId: number) => () => {
        test.db
          .insert(schema.graduatedVerses)
          .values({ userId: 'u1', materialId: MATERIAL_ID, verseId, graduatedAtSecs: NOW })
          .run();
        return Promise.resolve();
      };
      // Two writes queue behind the reset's lock on the deck; the second
      // resolves several ticks after the first.
      const reset = resetAccount(test.db, engines, 'u1');
      const first = engines.withLock(key, graduate(1));
      const second = engines.withLock(key, async () => {
        for (let tick = 0; tick < 10; tick++) await Promise.resolve();
        await graduate(2)();
      });
      const [summary] = await Promise.all([reset, first, second]);

      expect(test.db.select().from(schema.graduatedVerses).all()).toHaveLength(0);
      // The deck counts once, and the sweep's graduations count too.
      expect(summary).toEqual({ materialsReset: 1, eventsDeleted: 2, graduationsDeleted: 4 });
      expect(test.db.select().from(schema.userMaterials).all()).toHaveLength(0);
    } finally {
      engines.clear();
    }
  });
});
