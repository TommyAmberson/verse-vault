import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { NotEnrolledError } from './engine.js';
import { type UserMaterial, jsonBlob } from './keys.js';
import { type MaterialCard, buildMaterialTemplate, getMaterial } from './materials.js';

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
 */
export function enrollUser(args: EnrollArgs): { snapshotId: string; version: number } {
  const { db, userId, materialId } = args;
  const now = args.now ?? (() => Math.floor(Date.now() / 1000));

  const material = getMaterial(materialId);
  if (!material) throw new UnknownMaterialError(materialId);

  const existing = db
    .select()
    .from(schema.userMaterials)
    .where(
      and(
        eq(schema.userMaterials.userId, userId),
        eq(schema.userMaterials.materialId, materialId),
      ),
    )
    .get();
  if (existing) throw new AlreadyEnrolledError(userId, materialId);

  const template = buildMaterialTemplate(materialId);
  const snapshotId = randomUUID();
  const createdAt = now();

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

  return { snapshotId, version: 1 };
}
