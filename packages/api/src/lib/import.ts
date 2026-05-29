import { and, eq } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

import {
  buildCardRefIndex,
  type CardRefIndex,
  resolveCardRef,
} from './card-ref.js';
import { EngineStore } from './engine.js';
import {
  AlreadyEnrolledError,
  enrollUser,
  UnknownMaterialError,
} from './enrollment.js';
import type {
  AccountExport,
  ImportSummary,
  MaterialExport,
} from './export-format.js';
import {
  existingEventIds,
  type ReviewEventInput,
  writeReviewEvents,
} from './review-log.js';
import {
  ValidationError,
  validateYearSettings,
  type YearSettings,
} from './year-settings.js';

const SUPPORTED_EXPORT_VERSION = 1;

/** drizzle's `db.transaction` callback receives this narrower type;
 *  it shares the table-API surface (insert/update/select/delete) so
 *  the per-material helper functions accept it transparently. */
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

/** Apply an `AccountExport` payload to the calling user's account.
 *  Idempotent on re-application via `clientEventId` dedup. Settings
 *  merge via per-row `max(updatedAt)`: an older imported settings row
 *  doesn't blow away the user's tuned current settings. Each material
 *  is wrapped in its own transaction so a bad cardRef in one doesn't
 *  poison the others. After all materials are written we call
 *  `engines.rebuildFromEvents(key)` per material; that regenerates
 *  `test_states` from the full event log (now including the imported
 *  events) and is the entire reason we don't need to write FSRS
 *  state directly. */
export async function applyAccountImport(
  db: DB,
  engines: EngineStore,
  userId: string,
  payload: AccountExport,
  nowSecs: number,
): Promise<ImportSummary> {
  if (payload.exportVersion !== SUPPORTED_EXPORT_VERSION) {
    throw new ImportValidationError(
      `unsupported exportVersion: got ${payload.exportVersion}, supported ${SUPPORTED_EXPORT_VERSION}`,
    );
  }

  const summary: ImportSummary = {
    materialsApplied: 0,
    eventsInserted: 0,
    eventsSkipped: 0,
    graduationsApplied: 0,
    unresolvedCardRefs: 0,
  };

  for (const material of payload.materials) {
    // Ensure the user is enrolled; reuse existing enrollment if any.
    try {
      enrollUser({
        db,
        userId,
        materialId: material.materialId,
        clubTier: material.enrollment.clubTier ?? null,
        now: () => nowSecs,
      });
    } catch (err) {
      if (err instanceof AlreadyEnrolledError) {
        // Existing enrollment is fine — we layer the import on top.
      } else if (err instanceof UnknownMaterialError) {
        throw new ImportValidationError(
          `unknown materialId: ${material.materialId}`,
        );
      } else {
        throw err;
      }
    }

    const key = { userId, materialId: material.materialId };
    using loaded = await engines.load(key);
    const index = buildCardRefIndex(loaded.engine);
    const snapshotVersion = loaded.snapshotVersion;

    db.transaction((tx) => {
      applyEnrollmentExtras(tx, key, material);
      applySettings(tx, key, material);
      const gradResult = applyGraduations(tx, key, material, index);
      summary.graduationsApplied += gradResult.applied;
      summary.unresolvedCardRefs += gradResult.unresolved;
      const eventResult = applyReviewEvents(tx, key, material, index, snapshotVersion);
      summary.eventsInserted += eventResult.inserted;
      summary.eventsSkipped += eventResult.skipped;
      summary.unresolvedCardRefs += eventResult.unresolved;
    });

    // Replay the (now-augmented) event log into a fresh engine. This
    // wipes test_states for the material and re-derives it from the
    // committed reviewEvents — including everything we just inserted.
    engines.rebuildFromEvents(key);
    summary.materialsApplied += 1;
  }

  return summary;
}

function applyEnrollmentExtras(
  tx: Tx,
  key: { userId: string; materialId: string },
  material: MaterialExport,
): void {
  // enrollUser only ever sets clubTier; offlineMode comes via this
  // patch when it differs from the default.
  if (material.enrollment.offlineMode) {
    tx.update(schema.userMaterials)
      .set({ offlineMode: true })
      .where(
        and(
          eq(schema.userMaterials.userId, key.userId),
          eq(schema.userMaterials.materialId, key.materialId),
        ),
      )
      .run();
  }
}

function applySettings(
  tx: Tx,
  key: { userId: string; materialId: string },
  material: MaterialExport,
): void {
  if (!material.settings) return;

  const existing = tx
    .select({ updatedAt: schema.userYearSettings.updatedAt })
    .from(schema.userYearSettings)
    .where(
      and(
        eq(schema.userYearSettings.userId, key.userId),
        eq(schema.userYearSettings.materialId, key.materialId),
      ),
    )
    .get();

  // Per the plan's settings merge policy: newer updatedAt wins. If the
  // user has tuned settings since the export was taken, leave them be.
  if (existing && existing.updatedAt >= material.settings.updatedAt) return;

  // Validate the uploaded settings with the same rules the year-settings
  // route enforces — an import payload is no more trusted than a request
  // body. A bad enum/bound surfaces as a 400, not a corrupt row.
  let validated: YearSettings;
  try {
    validated = validateYearSettings(material.settings);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ImportValidationError(`settings for ${key.materialId}: ${err.message}`);
    }
    throw err;
  }

  const row = {
    userId: key.userId,
    materialId: key.materialId,
    ...validated,
    // Use the export-recorded `updatedAt` verbatim. It's the next-merge
    // anchor: a later re-import with the same anchor is a no-op, and
    // any local tweak after this row goes in stamps a newer ts via the
    // settings API and wins on the next merge.
    updatedAt: material.settings.updatedAt,
  };

  if (existing) {
    tx.update(schema.userYearSettings)
      .set(row)
      .where(
        and(
          eq(schema.userYearSettings.userId, key.userId),
          eq(schema.userYearSettings.materialId, key.materialId),
        ),
      )
      .run();
  } else {
    tx.insert(schema.userYearSettings).values(row).run();
  }
}

function applyGraduations(
  tx: Tx,
  key: { userId: string; materialId: string },
  material: MaterialExport,
  index: CardRefIndex,
): { applied: number; unresolved: number } {
  let applied = 0;
  let unresolved = 0;

  for (const g of material.graduatedVerses) {
    tx.insert(schema.graduatedVerses)
      .values({
        userId: key.userId,
        materialId: key.materialId,
        verseId: g.verseId,
        graduatedAtSecs: g.graduatedAtSecs,
      })
      .onConflictDoNothing()
      .run();
    applied += 1;
  }

  for (const g of material.graduatedCards) {
    const cardId = resolveCardRef(index, g.cardRef);
    if (cardId === undefined) {
      unresolved += 1;
      continue;
    }
    tx.insert(schema.graduatedCards)
      .values({
        userId: key.userId,
        materialId: key.materialId,
        cardId,
        graduatedAtSecs: g.graduatedAtSecs,
      })
      .onConflictDoNothing()
      .run();
    applied += 1;
  }

  return { applied, unresolved };
}

function applyReviewEvents(
  tx: Tx,
  key: { userId: string; materialId: string },
  material: MaterialExport,
  index: CardRefIndex,
  snapshotVersion: number,
): { inserted: number; skipped: number; unresolved: number } {
  // Resolve cardRefs to live cardIds, dropping any that don't exist in
  // the importing snapshot, and shape each into a ReviewEventInput.
  const resolved: ReviewEventInput[] = [];
  let unresolved = 0;
  for (const e of material.reviewEvents) {
    const cardId = resolveCardRef(index, e.cardRef);
    if (cardId === undefined) {
      unresolved += 1;
      continue;
    }
    resolved.push({
      userId: key.userId,
      materialId: key.materialId,
      snapshotVersion,
      timestampSecs: e.timestampSecs,
      cardId,
      grade: e.grade,
      clientEventId: e.clientEventId,
    });
  }

  const seen = existingEventIds(
    tx,
    key.userId,
    key.materialId,
    resolved.map((r) => r.clientEventId),
  );
  const fresh = resolved.filter((r) => !seen.has(r.clientEventId));

  writeReviewEvents(tx, fresh);

  return { inserted: fresh.length, skipped: resolved.length - fresh.length, unresolved };
}
