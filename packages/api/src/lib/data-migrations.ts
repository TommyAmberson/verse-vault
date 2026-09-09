import { and, eq, like } from 'drizzle-orm';
import { union } from 'drizzle-orm/sqlite-core';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import type { EngineStore } from './engine.js';

/**
 * TS-side data migrations: transformations that need the engine and so
 * can't live in the SQL migrations folder. Each is guarded by marker
 * rows in `data_migrations` and re-run at boot until complete, so a
 * crash or a skipped pair never strands rows behind a marker — and,
 * just as important, never re-processes rows it already converted.
 */

/** #141: persisted card ids were the builder's emission indices, which
 *  rebind on any config change. Core 0.8.0 made ids content-stable and
 *  ships the emission-order → stable-id table for exactly this
 *  translation, valid under the same config the rows were minted with —
 *  i.e. each user-material's config as stored at upgrade time. */
export const STABLE_CARD_IDS_MIGRATION = 'stable-card-ids-core-0.8';

function isApplied(db: DB, id: string): boolean {
  return (
    db
      .select({ id: schema.dataMigrations.id })
      .from(schema.dataMigrations)
      .where(eq(schema.dataMigrations.id, id))
      .get() !== undefined
  );
}

interface Pair {
  userId: string;
  materialId: string;
}

/** Per-pair marker id. Translation is transactional per pair, so
 *  idempotence must be tracked per pair too: a retry after a crash or a
 *  skipped neighbour must NOT re-feed a translated pair's stable ids
 *  through the legacy table (most would throw as out-of-range; verse-0
 *  ids are small enough to re-map silently to wrong cards). */
function pairMarker(pair: Pair): string {
  return `${STABLE_CARD_IDS_MIGRATION}:${pair.userId}:${pair.materialId}`;
}

function affectedPairs(db: DB): Pair[] {
  return union(
    db
      .select({
        userId: schema.graduatedCards.userId,
        materialId: schema.graduatedCards.materialId,
      })
      .from(schema.graduatedCards),
    db
      .select({ userId: schema.reviewEvents.userId, materialId: schema.reviewEvents.materialId })
      .from(schema.reviewEvents),
  ).all();
}

/** Build the pair's engine and pull its legacy→stable table. Isolated
 *  in a helper (not inlined in the caller's loop) deliberately: esbuild
 *  lowers `using` inside a loop with function-scoped error state, so an
 *  early iteration's throw would leak into later ones under vitest —
 *  a fresh function scope per call sidesteps the bad lowering. */
async function loadLegacyMap(engines: EngineStore, pair: Pair): Promise<number[] | null> {
  try {
    using loaded = await engines.load(pair);
    return JSON.parse(loaded.engine.legacy_card_id_map()) as number[];
  } catch (err) {
    console.error(
      `data-migrations: cannot build engine for ${pair.userId}/${pair.materialId}, skipping:`,
      err,
    );
    return null;
  }
}

/** Translate one pair's `graduated_cards` + `review_events` through the
 *  legacy map and write the pair's marker, all in one transaction — the
 *  marker must not exist without the translation nor vice versa.
 *  graduated_cards is keyed on (user, material, card_id) and a row's
 *  stable target can equal another row's still-legacy primary key, so
 *  those rows are deleted and re-inserted rather than updated in place;
 *  review_events rows are keyed by uuid and update in place. */
function translatePair(db: DB, pair: Pair, legacyToStable: number[], nowSecs: number): void {
  const mapped = (legacy: number): number => {
    const stable = legacyToStable[legacy];
    if (stable === undefined) {
      // An id outside the legacy emission range was not minted under
      // this config — data this migration must not guess about.
      throw new Error(
        `card id ${legacy} outside the legacy table (${legacyToStable.length} cards) for ${pair.userId}/${pair.materialId}`,
      );
    }
    return stable;
  };

  db.transaction((tx) => {
    const grads = tx
      .select()
      .from(schema.graduatedCards)
      .where(
        and(
          eq(schema.graduatedCards.userId, pair.userId),
          eq(schema.graduatedCards.materialId, pair.materialId),
        ),
      )
      .all();
    tx.delete(schema.graduatedCards)
      .where(
        and(
          eq(schema.graduatedCards.userId, pair.userId),
          eq(schema.graduatedCards.materialId, pair.materialId),
        ),
      )
      .run();
    for (const g of grads) {
      tx.insert(schema.graduatedCards)
        .values({ ...g, cardId: mapped(g.cardId) })
        .onConflictDoNothing()
        .run();
    }

    const events = tx
      .select({ id: schema.reviewEvents.id, cardId: schema.reviewEvents.cardId })
      .from(schema.reviewEvents)
      .where(
        and(
          eq(schema.reviewEvents.userId, pair.userId),
          eq(schema.reviewEvents.materialId, pair.materialId),
        ),
      )
      .all();
    for (const e of events) {
      const stable = mapped(e.cardId);
      if (stable !== e.cardId) {
        tx.update(schema.reviewEvents)
          .set({ cardId: stable })
          .where(eq(schema.reviewEvents.id, e.id))
          .run();
      }
    }

    tx.insert(schema.dataMigrations)
      .values({ id: pairMarker(pair), appliedAt: nowSecs })
      .run();
  });
}

async function runStableCardIds(db: DB, engines: EngineStore): Promise<void> {
  if (isApplied(db, STABLE_CARD_IDS_MIGRATION)) return;

  const pairs = affectedPairs(db);
  const nowSecs = Math.floor(Date.now() / 1000);
  let failed = 0;
  for (const pair of pairs) {
    if (isApplied(db, pairMarker(pair))) continue;
    const legacyToStable = await loadLegacyMap(engines, pair);
    if (legacyToStable === null) {
      failed += 1;
      continue;
    }
    try {
      translatePair(db, pair, legacyToStable, nowSecs);
    } catch (err) {
      // A pair that can't be translated (an id outside its legacy
      // table — minted under a config that has since changed) is left
      // untranslated for manual repair. The API must keep serving the
      // healthy pairs; killing boot here would turn one bad row into a
      // full outage.
      console.error(
        `data-migrations: translation failed for ${pair.userId}/${pair.materialId}, leaving pair untranslated:`,
        err,
      );
      failed += 1;
      continue;
    }
    // The cached engine replayed graduations with pre-translation ids —
    // drop it so the next load replays against the translated rows.
    engines.invalidate(pair);
  }

  if (failed > 0) {
    console.error(
      `data-migrations: ${STABLE_CARD_IDS_MIGRATION} incomplete — ${failed} of ${pairs.length} pairs pending; will retry next boot`,
    );
    return;
  }
  // Steady-state fast path: collapse the per-pair rows into the global
  // marker once nothing is pending.
  db.transaction((tx) => {
    tx.delete(schema.dataMigrations)
      .where(like(schema.dataMigrations.id, `${STABLE_CARD_IDS_MIGRATION}:%`))
      .run();
    tx.insert(schema.dataMigrations)
      .values({ id: STABLE_CARD_IDS_MIGRATION, appliedAt: nowSecs })
      .run();
  });
  console.log(
    `data-migrations: ${STABLE_CARD_IDS_MIGRATION} applied to ${pairs.length} user-materials`,
  );
}

/** Run all pending data migrations, in order. Called at boot after the
 *  SQL migrations and before serving; safe to re-run. */
export async function runDataMigrations(db: DB, engines: EngineStore): Promise<void> {
  await runStableCardIds(db, engines);
}
