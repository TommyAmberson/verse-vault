import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestDb, createTestUser } from '../test-utils.js';

import { buildCardRefIndex } from './card-ref.js';
import { EngineStore } from './engine.js';
import { buildAccountExport } from './export.js';

const MATERIAL_ID = 'nkjv-cor';
const NOW = 1_700_000_000;

describe('buildAccountExport', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('captures the user row, enrollment, settings, graduations, and review events', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: MATERIAL_ID });

    // Need an engine handle to translate cardIds → cardRefs.
    const engines = new EngineStore(test.db);
    let firstCardId: number;
    let firstVerseId: number;
    try {
      using loaded = await engines.load({ userId: 'u1', materialId: MATERIAL_ID });
      const index = buildCardRefIndex(loaded.engine);
      // Pick any cardId from the index — the indexer's round-trip
      // guarantee (cardId → ref → cardId) means whichever we pick will
      // appear in the export verbatim.
      const [cardId, ref] = index.byCardId.entries().next().value!;
      firstCardId = cardId;
      // verseId is required by the verse-bound CardRef variants — use the
      // ref's verseId if present, else any verseId from the catalogue.
      firstVerseId = 'verseId' in ref ? ref.verseId : 0;
    } finally {
      engines.clear();
    }

    test.db
      .insert(schema.userYearSettings)
      .values({
        userId: 'u1',
        materialId: MATERIAL_ID,
        headingCard: true,
        headingPassageCard: false,
        ftv: true,
        newScope: 'up150',
        reviewScope: 'all',
        clubCardScope: 'off',
        chapterListScope: 'up300',
        lessonBatchSize: 7,
        desiredRetention: 0.92,
        updatedAt: NOW - 100,
      })
      .run();

    test.db
      .insert(schema.graduatedVerses)
      .values({
        userId: 'u1',
        materialId: MATERIAL_ID,
        verseId: firstVerseId,
        graduatedAtSecs: NOW - 500,
      })
      .run();

    test.db
      .insert(schema.graduatedCards)
      .values({
        userId: 'u1',
        materialId: MATERIAL_ID,
        cardId: firstCardId,
        graduatedAtSecs: NOW - 400,
      })
      .run();

    test.db
      .insert(schema.reviewEvents)
      .values({
        id: randomUUID(),
        userId: 'u1',
        materialId: MATERIAL_ID,
        snapshotVersion: 1,
        timestampSecs: NOW - 200,
        cardId: firstCardId,
        grade: 3,
        clientEventId: 'seed-event-1',
        createdAt: NOW - 200,
      })
      .run();

    const engines2 = new EngineStore(test.db);
    try {
      const payload = await buildAccountExport(test.db, engines2, 'u1', NOW);

      expect(payload.exportVersion).toBe(1);
      expect(payload.exportedAt).toBe(NOW);
      expect(payload.user.email).toBe('u1@example.com');
      expect(payload.materials).toHaveLength(1);

      const mat = payload.materials[0]!;
      expect(mat.materialId).toBe(MATERIAL_ID);
      expect(mat.enrollment.clubTier).toBeNull();
      expect(mat.enrollment.offlineMode).toBe(false);
      expect(mat.snapshot.version).toBe(1);
      expect(mat.snapshot.contentSha).toMatch(/^[0-9a-f]{64}$/);

      expect(mat.settings).not.toBeNull();
      expect(mat.settings!.lessonBatchSize).toBe(7);
      expect(mat.settings!.desiredRetention).toBeCloseTo(0.92, 5);
      expect(mat.settings!.newScope).toBe('up150');
      expect(mat.settings!.updatedAt).toBe(NOW - 100);

      expect(mat.graduatedVerses).toEqual([
        { verseId: firstVerseId, graduatedAtSecs: NOW - 500 },
      ]);

      expect(mat.graduatedCards).toHaveLength(1);
      expect(mat.graduatedCards[0]!.graduatedAtSecs).toBe(NOW - 400);

      expect(mat.reviewEvents).toHaveLength(1);
      expect(mat.reviewEvents[0]!.clientEventId).toBe('seed-event-1');
      expect(mat.reviewEvents[0]!.grade).toBe(3);
      expect(mat.reviewEvents[0]!.timestampSecs).toBe(NOW - 200);
      // CardRef shape varies by kind; we just verify it was translated
      // (i.e. has a kind field) — the round-trip lives in import.test.
      expect(mat.reviewEvents[0]!.cardRef.kind).toBeDefined();
    } finally {
      engines2.clear();
    }
  });

  it('returns an empty materials array for a user with no enrollments', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'lonely');

    const engines = new EngineStore(test.db);
    try {
      const payload = await buildAccountExport(test.db, engines, 'lonely', NOW);
      expect(payload.materials).toEqual([]);
      expect(payload.user.email).toBe('lonely@example.com');
    } finally {
      engines.clear();
    }
  });

  it('orders reviewEvents by timestampSecs ascending', async () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    seedUserWithFixture({ db: test.db, userId: 'u1', materialId: MATERIAL_ID });

    const engines = new EngineStore(test.db);
    let cardId: number;
    try {
      using loaded = await engines.load({ userId: 'u1', materialId: MATERIAL_ID });
      const index = buildCardRefIndex(loaded.engine);
      cardId = index.byCardId.keys().next().value!;
    } finally {
      engines.clear();
    }

    // Insert events out of order to make sure the readback re-sorts them.
    for (const [ts, cid] of [[300, 'b'], [100, 'a'], [200, 'c']] as const) {
      test.db
        .insert(schema.reviewEvents)
        .values({
          id: randomUUID(),
          userId: 'u1',
          materialId: MATERIAL_ID,
          snapshotVersion: 1,
          timestampSecs: NOW - 1000 + ts,
          cardId,
          grade: 3,
          clientEventId: `evt-${cid}`,
          createdAt: NOW,
        })
        .run();
    }

    const engines2 = new EngineStore(test.db);
    try {
      const payload = await buildAccountExport(test.db, engines2, 'u1', NOW);
      const order = payload.materials[0]!.reviewEvents.map((e) => e.clientEventId);
      expect(order).toEqual(['evt-a', 'evt-c', 'evt-b']);
    } finally {
      engines2.clear();
    }
  });
});
