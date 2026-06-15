import { and, asc, eq } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

import { buildCardRefIndex, type CardRefIndex } from './card-ref.js';
import { EngineStore } from './engine.js';
import type { Grade } from './review-log.js';
import type {
  AccountExport,
  EnrollmentExport,
  GraduatedCardExport,
  GraduatedVerseExport,
  MaterialExport,
  MaterialSnapshotExport,
  ReviewEventExport,
  YearSettingsExport,
} from './export-format.js';

/** Assemble the export payload for one user. Walks every enrolled
 *  material, loads the engine once per material to build the cardId↔
 *  CardRef index, then reads graduations + reviews from the DB and
 *  translates them. The engine handle is bound with `using` so the
 *  refcount drops cleanly even on error. */
export async function buildAccountExport(
  db: DB,
  engines: EngineStore,
  userId: string,
  nowSecs: number,
): Promise<AccountExport> {
  const userRow = db
    .select({ email: schema.user.email, name: schema.user.name })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .get();
  if (!userRow) {
    throw new Error(`buildAccountExport: no user row for ${userId}`);
  }

  const enrollments = db
    .select()
    .from(schema.userMaterials)
    .where(eq(schema.userMaterials.userId, userId))
    .all();

  const materials: MaterialExport[] = [];
  for (const enrollment of enrollments) {
    const key = { userId, materialId: enrollment.materialId };
    using loaded = await engines.load(key);
    const index = buildCardRefIndex(loaded.engine);
    materials.push(buildMaterialExport(db, key, enrollment, loaded.snapshotVersion, index));
  }

  return {
    exportVersion: 1,
    exportedAt: nowSecs,
    user: { email: userRow.email, name: userRow.name },
    materials,
  };
}

function buildMaterialExport(
  db: DB,
  key: { userId: string; materialId: string },
  enrollmentRow: typeof schema.userMaterials.$inferSelect,
  snapshotVersion: number,
  index: CardRefIndex,
): MaterialExport {
  const enrollment: EnrollmentExport = {
    clubTier: enrollmentRow.clubTier,
    offlineMode: enrollmentRow.offlineMode,
    createdAt: enrollmentRow.createdAt,
  };

  const settings = readSettingsExport(db, key);
  const schedule = readScheduleExport(db, key);
  const snapshot = readSnapshotExport(db, key, snapshotVersion);
  const graduatedVerses = readGraduatedVerseExport(db, key);
  const graduatedCards = readGraduatedCardExport(db, key, index);
  const reviewEvents = readReviewEventExport(db, key, index);

  return {
    materialId: key.materialId,
    enrollment,
    settings,
    schedule,
    snapshot,
    graduatedVerses,
    graduatedCards,
    reviewEvents,
  };
}

function readSettingsExport(
  db: DB,
  key: { userId: string; materialId: string },
): YearSettingsExport | null {
  const row = db
    .select()
    .from(schema.userYearSettings)
    .where(
      and(
        eq(schema.userYearSettings.userId, key.userId),
        eq(schema.userYearSettings.materialId, key.materialId),
      ),
    )
    .get();
  if (!row) return null;
  return {
    headingCard: row.headingCard,
    headingPassageCard: row.headingPassageCard,
    ftv: row.ftv,
    newScope: row.newScope,
    reviewScope: row.reviewScope,
    clubCardScope: row.clubCardScope,
    chapterListScope: row.chapterListScope,
    lessonBatchSize: row.lessonBatchSize,
    desiredRetention: row.desiredRetention,
    configJson: row.configJson,
    updatedAt: row.updatedAt,
  };
}

function readScheduleExport(
  db: DB,
  key: { userId: string; materialId: string },
): import('./export-format.js').ScheduleExport | null {
  const row = db
    .select({
      scheduleJson: schema.materialSchedules.scheduleJson,
      updatedAt: schema.materialSchedules.updatedAt,
    })
    .from(schema.materialSchedules)
    .where(
      and(
        eq(schema.materialSchedules.userId, key.userId),
        eq(schema.materialSchedules.materialId, key.materialId),
      ),
    )
    .get();
  if (!row) return null;
  return { scheduleJson: row.scheduleJson, updatedAt: row.updatedAt };
}

function readSnapshotExport(
  db: DB,
  key: { userId: string; materialId: string },
  version: number,
): MaterialSnapshotExport {
  // `engines.load(key)` already advanced the user to the latest version;
  // we just read the row that matches it.
  const row = db
    .select({ contentSha: schema.graphSnapshots.contentSha })
    .from(schema.graphSnapshots)
    .where(
      and(
        eq(schema.graphSnapshots.userId, key.userId),
        eq(schema.graphSnapshots.materialId, key.materialId),
        eq(schema.graphSnapshots.version, version),
      ),
    )
    .get();
  return { version, contentSha: row?.contentSha ?? '' };
}

function readGraduatedVerseExport(
  db: DB,
  key: { userId: string; materialId: string },
): GraduatedVerseExport[] {
  return db
    .select({
      verseId: schema.graduatedVerses.verseId,
      graduatedAtSecs: schema.graduatedVerses.graduatedAtSecs,
    })
    .from(schema.graduatedVerses)
    .where(
      and(
        eq(schema.graduatedVerses.userId, key.userId),
        eq(schema.graduatedVerses.materialId, key.materialId),
      ),
    )
    .all();
}

function readGraduatedCardExport(
  db: DB,
  key: { userId: string; materialId: string },
  index: CardRefIndex,
): GraduatedCardExport[] {
  const rows = db
    .select({
      cardId: schema.graduatedCards.cardId,
      graduatedAtSecs: schema.graduatedCards.graduatedAtSecs,
    })
    .from(schema.graduatedCards)
    .where(
      and(
        eq(schema.graduatedCards.userId, key.userId),
        eq(schema.graduatedCards.materialId, key.materialId),
      ),
    )
    .all();
  const out: GraduatedCardExport[] = [];
  for (const row of rows) {
    const ref = index.byCardId.get(row.cardId);
    if (!ref) continue; // card no longer in the catalog; drop silently
    out.push({ cardRef: ref, graduatedAtSecs: row.graduatedAtSecs });
  }
  return out;
}

function readReviewEventExport(
  db: DB,
  key: { userId: string; materialId: string },
  index: CardRefIndex,
): ReviewEventExport[] {
  const rows = db
    .select({
      clientEventId: schema.reviewEvents.clientEventId,
      timestampSecs: schema.reviewEvents.timestampSecs,
      cardId: schema.reviewEvents.cardId,
      grade: schema.reviewEvents.grade,
    })
    .from(schema.reviewEvents)
    .where(
      and(
        eq(schema.reviewEvents.userId, key.userId),
        eq(schema.reviewEvents.materialId, key.materialId),
      ),
    )
    .orderBy(asc(schema.reviewEvents.timestampSecs), asc(schema.reviewEvents.clientEventId))
    .all();
  const out: ReviewEventExport[] = [];
  for (const row of rows) {
    const ref = index.byCardId.get(row.cardId);
    if (!ref) continue;
    out.push({
      clientEventId: row.clientEventId,
      timestampSecs: row.timestampSecs,
      cardRef: ref,
      grade: row.grade as Grade,
    });
  }
  return out;
}
