import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestDb, createTestUser } from '../test-utils.js';

import { buildCardRefIndex } from './card-ref.js';
import { EngineStore } from './engine.js';
import type { AccountExport, CardRef } from './export-format.js';
import { buildAccountExport } from './export.js';
import { applyAccountImport, ImportValidationError } from './import.js';

const MATERIAL_ID = 'nkjv-cor';
const NOW = 1_700_000_000;

/** Pick any (cardId, CardRef) pair from the engine for use as fixture
 *  data. Used by the round-trip tests to plant a review event with a
 *  valid cardRef before the export/import pass. */
async function pickAnyCard(
  engines: EngineStore,
  userId: string,
): Promise<{ cardId: number; ref: CardRef; verseId: number }> {
  using loaded = await engines.load({ userId, materialId: MATERIAL_ID });
  const index = buildCardRefIndex(loaded.engine);
  const [cardId, ref] = index.byCardId.entries().next().value!;
  const verseId = 'verseId' in ref ? ref.verseId : 0;
  return { cardId, ref, verseId };
}

describe('applyAccountImport', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('rejects unsupported exportVersion', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    const engines = new EngineStore(test.db);
    try {
      const payload = {
        exportVersion: 99,
        exportedAt: NOW,
        user: { email: 'x@example.com', name: 'x' },
        materials: [],
      } as unknown as AccountExport;
      await expect(applyAccountImport(test.db, engines, 'u1', payload, NOW)).rejects.toThrow(
        ImportValidationError,
      );
    } finally {
      engines.clear();
    }
  });

  it('rejects unknown materialIds', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    const engines = new EngineStore(test.db);
    try {
      const payload: AccountExport = {
        exportVersion: 1,
        exportedAt: NOW,
        user: { email: 'x@example.com', name: 'x' },
        materials: [
          {
            materialId: 'no-such-material',
            enrollment: { clubTier: null, offlineMode: false, createdAt: NOW },
            settings: null,
            snapshot: { version: 1, contentSha: '' },
            graduatedVerses: [],
            graduatedCards: [],
            reviewEvents: [],
          },
        ],
      };
      await expect(applyAccountImport(test.db, engines, 'u1', payload, NOW)).rejects.toThrow(
        ImportValidationError,
      );
    } finally {
      engines.clear();
    }
  });

  it('round-trips: export → import into fresh user → diff is empty', async () => {
    const src = createTestDb();
    cleanup = src.cleanup;
    seedUserWithFixture({ db: src.db, userId: 'src', materialId: MATERIAL_ID });

    const srcEngines = new EngineStore(src.db);
    const { cardId, verseId } = await pickAnyCard(srcEngines, 'src');

    src.db
      .insert(schema.userYearSettings)
      .values({
        userId: 'src',
        materialId: MATERIAL_ID,
        headingCard: true,
        headingPassageCard: true,
        ftv: false,
        newScope: 'up300',
        reviewScope: 'all',
        clubCardScope: 'up150',
        chapterListScope: 'off',
        lessonBatchSize: 5,
        desiredRetention: 0.88,
        updatedAt: NOW - 50,
      })
      .run();
    src.db
      .insert(schema.graduatedVerses)
      .values({ userId: 'src', materialId: MATERIAL_ID, verseId, graduatedAtSecs: NOW - 100 })
      .run();
    src.db
      .insert(schema.reviewEvents)
      .values([
        {
          id: randomUUID(),
          userId: 'src',
          materialId: MATERIAL_ID,
          snapshotVersion: 1,
          timestampSecs: NOW - 300,
          cardId,
          grade: 3,
          clientEventId: 'evt-1',
          createdAt: NOW - 300,
        },
        {
          id: randomUUID(),
          userId: 'src',
          materialId: MATERIAL_ID,
          snapshotVersion: 1,
          timestampSecs: NOW - 200,
          cardId,
          grade: 4,
          clientEventId: 'evt-2',
          createdAt: NOW - 200,
        },
      ])
      .run();

    const exportEngines = new EngineStore(src.db);
    let payload: AccountExport;
    try {
      payload = await buildAccountExport(src.db, exportEngines, 'src', NOW);
    } finally {
      exportEngines.clear();
      srcEngines.clear();
    }

    // Import into a fresh DB and a different userId. Enrollment doesn't
    // exist yet — the importer creates it via enrollUser.
    const dst = createTestDb();
    const dstCleanup = dst.cleanup;
    try {
      createTestUser(dst.db, 'dst');
      const dstEngines = new EngineStore(dst.db);
      try {
        const summary = await applyAccountImport(dst.db, dstEngines, 'dst', payload, NOW);
        expect(summary.materialsApplied).toBe(1);
        expect(summary.eventsInserted).toBe(2);
        expect(summary.eventsSkipped).toBe(0);
        expect(summary.unresolvedCardRefs).toBe(0);
        expect(summary.graduationsApplied).toBe(1);

        // Re-export from dst and confirm parity on the load-bearing
        // fields. We don't compare exportedAt or user email (different
        // user); we compare per-material payload shape.
        const reexport = await buildAccountExport(dst.db, dstEngines, 'dst', NOW);
        const srcMat = payload.materials[0]!;
        const dstMat = reexport.materials[0]!;
        expect(dstMat.materialId).toBe(srcMat.materialId);
        expect(dstMat.enrollment.clubTier).toBe(srcMat.enrollment.clubTier);
        expect(dstMat.settings).toEqual(srcMat.settings);
        expect(dstMat.graduatedVerses).toEqual(srcMat.graduatedVerses);
        expect(dstMat.reviewEvents.map((e) => e.clientEventId).sort()).toEqual(
          srcMat.reviewEvents.map((e) => e.clientEventId).sort(),
        );
      } finally {
        dstEngines.clear();
      }
    } finally {
      dstCleanup();
    }
  });

  it('is idempotent on re-import: second pass inserts nothing', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'src', materialId: MATERIAL_ID });

    const engines = new EngineStore(test.db);
    const { cardId } = await pickAnyCard(engines, 'src');

    test.db
      .insert(schema.reviewEvents)
      .values({
        id: randomUUID(),
        userId: 'src',
        materialId: MATERIAL_ID,
        snapshotVersion: 1,
        timestampSecs: NOW - 100,
        cardId,
        grade: 3,
        clientEventId: 'idem-1',
        createdAt: NOW - 100,
      })
      .run();

    const payload = await buildAccountExport(test.db, engines, 'src', NOW);

    // Import into the SAME user — re-application should hit dedup.
    const summary = await applyAccountImport(test.db, engines, 'src', payload, NOW);
    expect(summary.eventsInserted).toBe(0);
    expect(summary.eventsSkipped).toBe(1);
    engines.clear();
  });

  it('counts unresolved cardRefs without rejecting the import', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');
    const engines = new EngineStore(test.db);

    const payload: AccountExport = {
      exportVersion: 1,
      exportedAt: NOW,
      user: { email: 'u1@example.com', name: 'u1' },
      materials: [
        {
          materialId: MATERIAL_ID,
          enrollment: { clubTier: null, offlineMode: false, createdAt: NOW },
          settings: null,
          snapshot: { version: 1, contentSha: '' },
          graduatedVerses: [],
          graduatedCards: [
            // A heading idx no live deck would emit — should fall into
            // unresolved without aborting.
            {
              cardRef: { kind: 'HeadingPassage', headingIdx: 999_999 },
              graduatedAtSecs: NOW - 100,
            },
          ],
          reviewEvents: [
            {
              clientEventId: 'phantom-1',
              timestampSecs: NOW - 200,
              cardRef: { kind: 'HeadingPassage', headingIdx: 999_999 },
              grade: 3,
            },
          ],
        },
      ],
    };

    try {
      const summary = await applyAccountImport(test.db, engines, 'u1', payload, NOW);
      expect(summary.materialsApplied).toBe(1);
      expect(summary.eventsInserted).toBe(0);
      expect(summary.unresolvedCardRefs).toBe(2);
    } finally {
      engines.clear();
    }
  });

  it('preserves newer settings over an older imported settings row', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: MATERIAL_ID });

    // User's current (newer) settings.
    test.db
      .insert(schema.userYearSettings)
      .values({
        userId: 'u1',
        materialId: MATERIAL_ID,
        headingCard: true,
        headingPassageCard: true,
        ftv: true,
        newScope: 'all',
        reviewScope: 'all',
        clubCardScope: 'all',
        // chapterListScope rejects 'all' — Full never emits a chapter list.
        chapterListScope: 'up300',
        lessonBatchSize: 10,
        desiredRetention: 0.95,
        updatedAt: NOW, // newer
      })
      .run();

    const payload: AccountExport = {
      exportVersion: 1,
      exportedAt: NOW,
      user: { email: 'u1@example.com', name: 'u1' },
      materials: [
        {
          materialId: MATERIAL_ID,
          enrollment: { clubTier: null, offlineMode: false, createdAt: NOW },
          settings: {
            headingCard: false,
            headingPassageCard: false,
            ftv: false,
            newScope: 'off',
            reviewScope: 'off',
            clubCardScope: 'off',
            chapterListScope: 'off',
            lessonBatchSize: 1,
            desiredRetention: 0.5,
            updatedAt: NOW - 10_000, // older
          },
          snapshot: { version: 1, contentSha: '' },
          graduatedVerses: [],
          graduatedCards: [],
          reviewEvents: [],
        },
      ],
    };

    const engines = new EngineStore(test.db);
    try {
      await applyAccountImport(test.db, engines, 'u1', payload, NOW);
      const row = test.db.select().from(schema.userYearSettings).all()[0]!;
      expect(row.lessonBatchSize).toBe(10);
      expect(row.desiredRetention).toBeCloseTo(0.95, 5);
    } finally {
      engines.clear();
    }
  });
});
