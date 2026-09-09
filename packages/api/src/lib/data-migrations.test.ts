import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { dataMigrations, graduatedCards, reviewEvents } from '../db/schema.js';
import { seedEnrolledUser } from '../test-fixtures.js';
import { type TestApp, createTestApp } from '../test-utils.js';
import { STABLE_CARD_IDS_MIGRATION, runDataMigrations } from './data-migrations.js';

const MATERIAL_ID = 'nkjv-cor';

describe('stable-card-ids data migration', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('translates legacy emission-index ids and is idempotent', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { userId } = await seedEnrolledUser(test, 'ids@example.com', MATERIAL_ID);

    // The authoritative expectation, from the same source the migration
    // uses: emission index i was the id a pre-0.8.0 build assigned.
    using loaded = await test.engines.load({ userId, materialId: MATERIAL_ID });
    const legacyMap = JSON.parse(loaded.engine.legacy_card_id_map()) as number[];
    expect(legacyMap.length).toBeGreaterThan(10);

    // Seed rows the way a 0.7.x release wrote them: raw emission indices.
    test.db
      .insert(graduatedCards)
      .values([
        { userId, materialId: MATERIAL_ID, cardId: 0, graduatedAtSecs: 1_700_000_000 },
        { userId, materialId: MATERIAL_ID, cardId: 8, graduatedAtSecs: 1_700_000_001 },
      ])
      .run();
    test.db
      .insert(reviewEvents)
      .values({
        id: 'ev-legacy-1',
        userId,
        materialId: MATERIAL_ID,
        snapshotVersion: 1,
        timestampSecs: 1_700_000_002,
        cardId: 5,
        grade: 3,
        clientEventId: 'ce-legacy-1',
        createdAt: 1_700_000_002,
      })
      .run();

    await runDataMigrations(test.db, test.engines);

    const gradIds = test.db
      .select({ cardId: graduatedCards.cardId })
      .from(graduatedCards)
      .all()
      .map((r) => r.cardId)
      .sort((a, b) => a - b);
    expect(gradIds).toEqual([legacyMap[0], legacyMap[8]].sort((a, b) => a - b));

    const ev = test.db.select().from(reviewEvents).all();
    expect(ev).toHaveLength(1);
    expect(ev[0].cardId).toBe(legacyMap[5]);

    const marker = test.db.select().from(dataMigrations).all();
    expect(marker.map((m) => m.id)).toContain(STABLE_CARD_IDS_MIGRATION);

    // Second run: marker short-circuits; rows untouched (a re-translation
    // would corrupt them — stable ids are NOT legacy indices).
    await runDataMigrations(test.db, test.engines);
    const after = test.db.select().from(reviewEvents).all();
    expect(after[0].cardId).toBe(legacyMap[5]);
  });

  it('skips an untranslatable pair, keeps serving, and retries it next boot', async () => {
    // Two pairs: one healthy, one carrying an id outside its legacy
    // table (minted under a config that has since changed). The broken
    // pair must not kill boot, must not block the healthy pair, and —
    // critically — a retry must NOT re-translate the healthy pair:
    // feeding stable ids back through the legacy table throws for big
    // ids and silently corrupts for small (verse-0) ones.
    const test = createTestApp();
    cleanup = test.cleanup;
    const healthy = await seedEnrolledUser(test, 'ids-healthy@example.com', MATERIAL_ID);
    const broken = await seedEnrolledUser(test, 'ids-broken@example.com', MATERIAL_ID);

    using loaded = await test.engines.load({ userId: healthy.userId, materialId: MATERIAL_ID });
    const legacyMap = JSON.parse(loaded.engine.legacy_card_id_map()) as number[];

    test.db
      .insert(graduatedCards)
      .values([
        { userId: healthy.userId, materialId: MATERIAL_ID, cardId: 8, graduatedAtSecs: 1 },
        { userId: broken.userId, materialId: MATERIAL_ID, cardId: 999_999, graduatedAtSecs: 1 },
      ])
      .run();

    // Boot 1: healthy translated, broken skipped, global marker absent.
    await runDataMigrations(test.db, test.engines);
    const healthyRow = () =>
      test.db
        .select({ cardId: graduatedCards.cardId })
        .from(graduatedCards)
        .where(eq(graduatedCards.userId, healthy.userId))
        .all();
    expect(healthyRow()[0].cardId).toBe(legacyMap[8]);
    let markers = test.db.select().from(dataMigrations).all().map((m) => m.id);
    expect(markers).not.toContain(STABLE_CARD_IDS_MIGRATION);
    expect(markers.some((id) => id.includes(healthy.userId))).toBe(true);

    // Boot 2 (nothing fixed): healthy pair untouched — the per-pair
    // marker is what stands between a retry and double-translation.
    await runDataMigrations(test.db, test.engines);
    expect(healthyRow()[0].cardId).toBe(legacyMap[8]);

    // Operator repairs the broken row; boot 3 completes and collapses
    // the per-pair rows into the global marker.
    test.db
      .update(graduatedCards)
      .set({ cardId: 8 })
      .where(eq(graduatedCards.userId, broken.userId))
      .run();
    await runDataMigrations(test.db, test.engines);
    expect(healthyRow()[0].cardId).toBe(legacyMap[8]);
    markers = test.db.select().from(dataMigrations).all().map((m) => m.id);
    expect(markers).toContain(STABLE_CARD_IDS_MIGRATION);
    expect(markers).toHaveLength(1);
  });
});
