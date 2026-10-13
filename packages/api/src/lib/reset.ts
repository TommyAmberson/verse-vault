import { and, eq, notInArray } from 'drizzle-orm';

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
export function deleteAccountProgress(
  db: DB,
  engines: EngineStore,
  userId: string,
): Promise<ProgressDeletionSummary> {
  return wipeAccount(db, engines, userId, []);
}

/**
 * Return the account to the state of a new one: everything
 * `deleteAccountProgress` removes, plus enrolment, per-year settings,
 * custom schedules, and content snapshots. The user row, its sign-in
 * methods, its verified address, and its sessions stay. Same locking,
 * invalidation, and summary as `deleteAccountProgress`.
 */
export function resetAccount(
  db: DB,
  engines: EngineStore,
  userId: string,
): Promise<ProgressDeletionSummary> {
  return wipeAccount(db, engines, userId, SETUP_TABLES);
}

/** Tables only a full reset clears, keyed by user and material. */
const SETUP_TABLES = [
  schema.userMaterials,
  schema.userYearSettings,
  schema.materialSchedules,
  schema.graphSnapshots,
] as const;

/** Progress tables a full reset sweeps for materials no longer enrolled. */
const PROGRESS_TABLES = [
  schema.reviewEvents,
  schema.testStates,
  schema.graduatedVerses,
  schema.graduatedCards,
] as const;

async function wipeAccount(
  db: DB,
  engines: EngineStore,
  userId: string,
  // Cleared too, beyond progress: a full reset passes `SETUP_TABLES`.
  extraTables: readonly (typeof SETUP_TABLES)[number][],
): Promise<ProgressDeletionSummary> {
  const enrolled = () =>
    db
      .select({ materialId: schema.userMaterials.materialId })
      .from(schema.userMaterials)
      .where(eq(schema.userMaterials.userId, userId))
      .all()
      .map((row) => row.materialId);

  // Each deck counts once, however many passes or sweeps touched it.
  const changedMaterials = new Set<string>();
  let eventsDeleted = 0;
  let graduationsDeleted = 0;
  const cleared = new Set<string>();

  // A full reset clears enrolment too, so a deck enrolled meanwhile (on
  // another device) is still enrolled afterwards: clear it as well, under
  // its lock, until a pass finds none. Progress-only wipes keep enrolment,
  // so one pass is all they need.
  for (let pass = 0; pass < 3; pass++) {
    const materials = enrolled();
    if (materials.length === 0) break;
    await clearMaterials(materials);
    if (extraTables.length === 0) break;
  }

  async function clearMaterials(materialIds: string[]) {
    for (const materialId of materialIds) {
      cleared.add(materialId);
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
          for (const table of extraTables) {
            materialChanges += tx
              .delete(table)
              .where(and(eq(table.userId, userId), eq(table.materialId, materialId)))
              .run().changes;
          }
        });
        if (materialChanges > 0) {
          changedMaterials.add(materialId);
          engines.invalidate(key);
        }
      });
    }
  }

  // A full reset also clears every row for materials the account no longer
  // enrols in: a dropped deck's setup, and progress that writes waiting on
  // a cleared deck's lock add after its pass, which would otherwise block
  // enrolling it again. Each sweep takes the deck's lock so it runs after
  // those writes. A deck enrolled again after the last pass is skipped
  // and keeps its state whole.
  if (extraTables.length > 0) {
    const orphanTables = [...PROGRESS_TABLES, ...extraTables];
    const stillEnrolled = () =>
      db
        .select({ materialId: schema.userMaterials.materialId })
        .from(schema.userMaterials)
        .where(eq(schema.userMaterials.userId, userId));
    const swept = new Set(cleared);
    for (const table of orphanTables) {
      db.selectDistinct({ materialId: table.materialId })
        .from(table)
        .where(and(eq(table.userId, userId), notInArray(table.materialId, stillEnrolled())))
        .all()
        .forEach((row) => swept.add(row.materialId));
    }
    for (const materialId of swept) {
      const key = { userId, materialId };
      await engines.withLock(key, async () => {
        db.transaction((tx) => {
          for (const table of orphanTables) {
            const { changes } = tx
              .delete(table)
              .where(
                and(
                  eq(table.userId, userId),
                  eq(table.materialId, materialId),
                  notInArray(table.materialId, stillEnrolled()),
                ),
              )
              .run();
            if (changes === 0) continue;
            changedMaterials.add(materialId);
            if (table === schema.reviewEvents) eventsDeleted += changes;
            if (table === schema.graduatedVerses || table === schema.graduatedCards) {
              graduationsDeleted += changes;
            }
          }
        });
        engines.invalidate(key);
      });
    }
  }

  // Held events for every material, including a dropped deck or one
  // enrolled since its pass, so none is promoted later.
  db.delete(schema.pendingEvents).where(eq(schema.pendingEvents.userId, userId)).run();

  return { materialsReset: changedMaterials.size, eventsDeleted, graduationsDeleted };
}
