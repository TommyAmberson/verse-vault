import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { NotEnrolledError } from './engine.js';
import { type UserMaterial, jsonBlob } from './keys.js';
import { type MaterialCard, buildMaterialTemplate, getMaterial } from './materials.js';

/** better-sqlite3 surfaces constraint violations on `.code`. */
function isUserMaterialsPkViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return (
    (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') &&
    err.message.includes('user_materials')
  );
}

export interface EnrollArgs {
  db: DB;
  userId: string;
  materialId: string;
  clubTier?: number | null;
  now?: () => number;
}

export class UnknownMaterialError extends Error {
  constructor(materialId: string) {
    super(`Unknown material: ${materialId}`);
    this.name = 'UnknownMaterialError';
  }
}

export class AlreadyEnrolledError extends Error {
  constructor(userId: string, materialId: string) {
    super(`Already enrolled: user=${userId} material=${materialId}`);
    this.name = 'AlreadyEnrolledError';
  }
}

/**
 * Returns the user_materials row for the caller, or throws NotEnrolledError.
 * Route handlers `try { … } catch (NotEnrolledError)` → 404, matching the
 * sync-endpoint pattern.
 */
export function requireEnrollment(
  db: DB,
  key: UserMaterial,
): typeof schema.userMaterials.$inferSelect {
  const row = db
    .select()
    .from(schema.userMaterials)
    .where(
      and(
        eq(schema.userMaterials.userId, key.userId),
        eq(schema.userMaterials.materialId, key.materialId),
      ),
    )
    .get();
  if (!row) throw new NotEnrolledError(key);
  return row;
}

/**
 * Enrolls a user in a material. Inserts the `user_materials` row, the initial
 * `graph_snapshots` row from the material template, and seeds `card_states`
 * so status queries can hit a populated table even before the first review.
 *
 * The user_materials PK on (user_id, material_id) is the authoritative guard
 * against duplicate enrollment — a concurrent double-enroll is mapped to
 * AlreadyEnrolledError rather than bubbling up as a 500.
 */
export function enrollUser(args: EnrollArgs): { snapshotId: string; version: number } {
  const { db, userId, materialId } = args;
  const now = args.now ?? (() => Math.floor(Date.now() / 1000));

  const material = getMaterial(materialId);
  if (!material) throw new UnknownMaterialError(materialId);

  const template = buildMaterialTemplate(materialId);
  const snapshotId = randomUUID();
  const createdAt = now();

  try {
    db.transaction((tx) => {
      tx.insert(schema.userMaterials)
        .values({
          userId,
          materialId,
          clubTier: args.clubTier ?? null,
          createdAt,
        })
        .run();
      tx.insert(schema.graphSnapshots)
        .values({
          id: snapshotId,
          userId,
          materialId,
          version: 1,
          graphData: jsonBlob(template.graph),
          cardsData: jsonBlob(template.cards),
          createdAt,
        })
        .run();

      // MaterialCard.state stays PascalCase because that's what Rust's serde
      // produces for the CardState enum on the WASM side; card_states on the
      // DB is the lowercase union so we normalize on the way in.
      const cardRows = template.cards.map((c: MaterialCard) => ({
        userId,
        materialId,
        cardId: c.id,
        state: c.state.toLowerCase() as Lowercase<MaterialCard['state']>,
        dueR: null,
        dueDateSecs: null,
        priority: null,
      }));
      if (cardRows.length > 0) {
        tx.insert(schema.cardStates).values(cardRows).run();
      }
    });
  } catch (err) {
    if (isUserMaterialsPkViolation(err)) throw new AlreadyEnrolledError(userId, materialId);
    throw err;
  }

  return { snapshotId, version: 1 };
}
