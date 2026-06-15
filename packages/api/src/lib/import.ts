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
import { ScheduleValidationError, validateSchedule } from './schedules.js';

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
 *  poison the others. After each material's writes land we call
 *  `engines.rebuildFromEvents(key)` for that material; that regenerates
 *  `test_states` from the full event log (now including the imported
 *  events) and is the entire reason we don't need to write FSRS
 *  state directly. The whole per-material pass runs under the engine's
 *  per-key lock so the rebuild can't race a concurrent review. */
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
    // Hold the per-key lock across load + writes + rebuild: the
    // `rebuildFromEvents` delete-then-insert of test_states must not
    // race a concurrent review POST for the same (user, material).
    // Mirrors sync.ts, which wraps its own rebuild in withLock.
    await engines.withLock(key, async () => {
      // STEP 1: apply enrollment + settings BEFORE building the card-
      // ref index. The cardId universe is config-dependent (builder.rs
      // gates Ftv / HeadingPassage / VerseInClub / etc. emission on
      // MaterialConfig flags), and the imported settings may turn
      // those flags on or off. Resolving cardRefs against the engine
      // built with the user's OLD settings drops cardRefs that should
      // be resolvable post-import (and silently misroutes ones whose
      // cardId number happens to overlap between configs). Apply
      // settings first, then invalidate the engine cache, then load
      // a fresh engine that reads the new config.
      //
      // Tradeoff vs. the previous all-in-one transaction: if step 3
      // (graduations + events) fails, the settings + enrollment from
      // step 1 stay committed. For an import the user can re-run the
      // operation — the import is idempotent on review events
      // (clientEventId dedup) and on graduations (existing-row check
      // in applyGraduations), so a second run picks up where the
      // first left off without duplicates. Atomicity across all three
      // would require a multi-stage compensating-write design we
      // don't need for the import use case.
      db.transaction((tx) => {
        applyEnrollmentExtras(tx, key, material);
        applySettings(tx, key, material);
        applySchedule(tx, key, material);
      });
      engines.invalidate(key);

      // STEP 2: load the engine with the just-applied settings and
      // build the cardRef index. Subsequent applyGraduations /
      // applyReviewEvents now resolve against the correct card
      // universe.
      using loaded = await engines.load(key);
      const index = buildCardRefIndex(loaded.engine);
      const snapshotVersion = loaded.snapshotVersion;

      // STEP 3: graduations + events in their own transaction.
      db.transaction((tx) => {
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
      // Bind the returned handle with `using` so its refcount (bumped by
      // rebuildFromEvents) is released at scope exit.
      using _rebuilt = engines.rebuildFromEvents(key);
    });
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

  // Phase 1: take the per-club configJson from the export when present
  // (newer exports already carry it). Older exports omit the field —
  // keep configJson null in that case so `readMaterialConfigJson`'s
  // fallback path synthesises from the legacy columns on next read.
  // Synthesising at import time would break round-trip equality with
  // pre-Phase-1 export shapes.
  const configJson =
    material.settings.configJson !== undefined && material.settings.configJson !== null
      ? material.settings.configJson
      : null;

  const row = {
    userId: key.userId,
    materialId: key.materialId,
    ...validated,
    configJson,
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

/** Phase 1: apply an imported per-material memorize schedule override.
 *  Optional — older exports omit the field; absent → no-op. Validated
 *  with the same shape-check the PUT route applies so bad imports
 *  surface as a 400 instead of corrupting the row.
 *
 *  Merge policy mirrors `applySettings`: newer updatedAt wins. A later
 *  re-import with the same anchor is a no-op; a local edit after this
 *  row goes in stamps a newer ts via the PUT route and wins on the next
 *  merge.
 *
 *  Lives in STEP 1 of `applyAccountImport`'s three-step transaction so
 *  the engine.load() in STEP 2 picks up the imported schedule before
 *  the cardref index is built. */
function applySchedule(
  tx: Tx,
  key: { userId: string; materialId: string },
  material: MaterialExport,
): void {
  if (!material.schedule) return;
  try {
    validateSchedule(material.schedule.scheduleJson);
  } catch (err) {
    if (err instanceof ScheduleValidationError) {
      throw new ImportValidationError(`schedule for ${key.materialId}: ${err.message}`);
    }
    throw err;
  }
  const existing = tx
    .select({ updatedAt: schema.materialSchedules.updatedAt })
    .from(schema.materialSchedules)
    .where(
      and(
        eq(schema.materialSchedules.userId, key.userId),
        eq(schema.materialSchedules.materialId, key.materialId),
      ),
    )
    .get();
  if (existing && existing.updatedAt >= material.schedule.updatedAt) return;

  const row = {
    userId: key.userId,
    materialId: key.materialId,
    scheduleJson: material.schedule.scheduleJson,
    updatedAt: material.schedule.updatedAt,
  };
  if (existing) {
    tx.update(schema.materialSchedules)
      .set(row)
      .where(
        and(
          eq(schema.materialSchedules.userId, key.userId),
          eq(schema.materialSchedules.materialId, key.materialId),
        ),
      )
      .run();
  } else {
    tx.insert(schema.materialSchedules).values(row).run();
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
    const res = tx
      .insert(schema.graduatedVerses)
      .values({
        userId: key.userId,
        materialId: key.materialId,
        verseId: g.verseId,
        graduatedAtSecs: g.graduatedAtSecs,
      })
      .onConflictDoNothing()
      .run();
    // Count only rows actually written, so a re-import (where every row
    // hits onConflictDoNothing) honestly reports 0 graduations applied.
    if (res.changes > 0) applied += 1;
  }

  for (const g of material.graduatedCards) {
    const cardId = resolveCardRef(index, g.cardRef);
    if (cardId === undefined) {
      unresolved += 1;
      continue;
    }
    const res = tx
      .insert(schema.graduatedCards)
      .values({
        userId: key.userId,
        materialId: key.materialId,
        cardId,
        graduatedAtSecs: g.graduatedAtSecs,
      })
      .onConflictDoNothing()
      .run();
    if (res.changes > 0) applied += 1;
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
  //
  // Every scalar field on the imported event is validated here. Sync's
  // validateUpload (routes/sync.ts:439) gates the same fields and
  // returns 400 on the same conditions; import drops bad rows into
  // `unresolved` instead so a single malformed row doesn't reject an
  // otherwise-good 50 MB import. The validators must match sync's
  // shape exactly because the same poison-and-wedge class applies to
  // every field that flows into `rebuildFromEvents`:
  //   - `grade`: `engine.replay_event` (wasm/src/lib.rs) returns a
  //     JsError on values outside 1..=4. Pre-fix, `grade: 99` committed
  //     and then wedged every subsequent sync/rebuild on the same
  //     (user, material).
  //   - `timestampSecs`: `EngineStore.rebuildFromEvents` (lib/engine.ts)
  //     calls `BigInt(row.timestampSecs)`, which throws synchronously
  //     on NaN / Infinity / non-integer. Same wedge class: bad row
  //     commits, every subsequent rebuild 500s.
  //   - `clientEventId`: column is NOT NULL with a unique index on
  //     (user, material, clientEventId). Empty string or null aborts
  //     the whole tx on insert (500, no commit — so no wedge — but
  //     still a sharp edge sync rejects with 400).
  const resolved: ReviewEventInput[] = [];
  let unresolved = 0;
  for (const e of material.reviewEvents) {
    const cardId = resolveCardRef(index, e.cardRef);
    if (cardId === undefined) {
      unresolved += 1;
      continue;
    }
    if (!Number.isInteger(e.grade) || e.grade < 1 || e.grade > 4) {
      unresolved += 1;
      continue;
    }
    if (!Number.isInteger(e.timestampSecs) || e.timestampSecs < 0) {
      unresolved += 1;
      continue;
    }
    if (typeof e.clientEventId !== 'string' || e.clientEventId.length === 0) {
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
