import { and, eq } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

import { EngineStore } from './engine.js';

export interface ProgressDeletionSummary {
  /** Enrolled materials that actually had rows removed. */
  materialsReset: number;
  /** Total `review_events` rows removed across all materials. */
  eventsDeleted: number;
  /** `graduated_verses` + `graduated_cards` rows removed. */
  graduationsDeleted: number;
}

/**
 * Wipe a user's learning state — review events, graduations, the
 * derived test_states, and events sync took but did not apply — across
 * every material they're enrolled in. Held events go too, or a later
 * build or merge answer would promote pre-reset work back into the
 * freshly emptied log.
 * Enrollment (`user_materials`), per-year settings, and the content
 * snapshot are deliberately kept: decks stay in the user's list, reset
 * to all-new. Each material is cleared under the engine's per-key lock
 * (mirroring import / rebuildFromEvents) so the delete can't race a
 * concurrent review POST, then the cached engine is invalidated so the
 * next load rebuilds from the now-empty event log.
 *
 * Idempotent: a second call finds nothing to delete and returns zeros.
 */
export async function deleteAccountProgress(
  db: DB,
  engines: EngineStore,
  userId: string,
): Promise<ProgressDeletionSummary> {
  const materials = db
    .select({ materialId: schema.userMaterials.materialId })
    .from(schema.userMaterials)
    .where(eq(schema.userMaterials.userId, userId))
    .all();

  let materialsReset = 0;
  let eventsDeleted = 0;
  let graduationsDeleted = 0;

  for (const { materialId } of materials) {
    const key = { userId, materialId };
    await engines.withLock(key, async () => {
      let materialChanges = 0;
      db.transaction((tx) => {
        const ev = tx
          .delete(schema.reviewEvents)
          .where(
            and(
              eq(schema.reviewEvents.userId, userId),
              eq(schema.reviewEvents.materialId, materialId),
            ),
          )
          .run();
        const gv = tx
          .delete(schema.graduatedVerses)
          .where(
            and(
              eq(schema.graduatedVerses.userId, userId),
              eq(schema.graduatedVerses.materialId, materialId),
            ),
          )
          .run();
        const gc = tx
          .delete(schema.graduatedCards)
          .where(
            and(
              eq(schema.graduatedCards.userId, userId),
              eq(schema.graduatedCards.materialId, materialId),
            ),
          )
          .run();
        const held = tx
          .delete(schema.pendingEvents)
          .where(
            and(
              eq(schema.pendingEvents.userId, userId),
              eq(schema.pendingEvents.materialId, materialId),
            ),
          )
          .run();
        const ts = tx
          .delete(schema.testStates)
          .where(
            and(
              eq(schema.testStates.userId, userId),
              eq(schema.testStates.materialId, materialId),
            ),
          )
          .run();
        eventsDeleted += ev.changes;
        graduationsDeleted += gv.changes + gc.changes;
        materialChanges = ev.changes + gv.changes + gc.changes + held.changes + ts.changes;
      });
      if (materialChanges > 0) {
        materialsReset += 1;
        engines.invalidate(key);
      }
    });
  }

  // Held for materials the account never enrolled in: nothing builds an
  // engine for those, so no lock is needed.
  db.delete(schema.pendingEvents).where(eq(schema.pendingEvents.userId, userId)).run();

  return { materialsReset, eventsDeleted, graduationsDeleted };
}
