import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { WasmEngine } from 'verse-vault-wasm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { NotEnrolledError, sha256Memo, type TestStateEntry } from './engine.js';
import type { UserMaterial } from './keys.js';
import { getMaterial, getMaterialJson } from './materials.js';
import { writeTestStates } from './review-log.js';

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
  /** Optional override for the bundled MaterialData JSON. Tests pass a tiny
   * inline material to avoid loading multi-hundred-kB blobs from disk. */
  materialJson?: string;
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

/** Boolean form of `requireEnrollment` — for callers that need to branch
 *  on enrollment without throwing. */
export function isEnrolled(db: DB, key: UserMaterial): boolean {
  return !!db
    .select({ userId: schema.userMaterials.userId })
    .from(schema.userMaterials)
    .where(
      and(
        eq(schema.userMaterials.userId, key.userId),
        eq(schema.userMaterials.materialId, key.materialId),
      ),
    )
    .get();
}

/**
 * Enrolls a user in a material. Inserts the `user_materials` row, the initial
 * `graph_snapshots` row from the material JSON, and seeds `test_states` from
 * the freshly-built engine (one row per `TestKey` reachable from any card)
 * so stats queries hit a populated table even before the first review.
 *
 * The `user_materials` PK on (user_id, material_id) is the authoritative
 * guard against duplicate enrollment — a concurrent double-enroll is mapped
 * to `AlreadyEnrolledError` rather than bubbling up as a 500.
 */
export function enrollUser(args: EnrollArgs): { snapshotId: string; version: number } {
  const { db, userId, materialId } = args;
  const now = args.now ?? (() => Math.floor(Date.now() / 1000));

  const material = getMaterial(materialId);
  if (!material) throw new UnknownMaterialError(materialId);

  const materialJson = args.materialJson ?? getMaterialJson(materialId);
  const snapshotId = randomUUID();
  const createdAt = now();

  // Empty config = parse_material_config('')'s test-friendly fallback
  // (all clubs enabled) — enrollment seeds the same card set regardless
  // of per-user picker choices; those are applied at query time (slice 1)
  // and at /memorize introduction (slice 2). Empty schedule too: the
  // seed run only needs the build/test_state pipeline, not the
  // schedule-aware memorize batcher.
  const seedEngine = new WasmEngine(materialJson, '', '', '', BigInt(createdAt));
  let testStates: TestStateEntry[];
  try {
    testStates = JSON.parse(seedEngine.export_test_states()) as TestStateEntry[];
  } finally {
    seedEngine.free();
  }

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
          contentSha: sha256Memo(materialJson),
          createdAt,
        })
        .run();
      writeTestStates(tx, userId, materialId, testStates, { onConflict: false });
    });
  } catch (err) {
    if (isUserMaterialsPkViolation(err)) throw new AlreadyEnrolledError(userId, materialId);
    throw err;
  }

  return { snapshotId, version: 1 };
}
