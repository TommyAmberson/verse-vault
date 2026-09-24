import { WasmEngine, max_emission_config_json } from 'verse-vault-wasm';

import type { DB } from './db/client.js';
import { enrollUser } from './lib/enrollment.js';
import { getMaterialJson } from './lib/materials.js';
import { type TestApp, createTestUser, signUpTestUser } from './test-utils.js';

export interface SeedOptions {
  db: DB;
  userId: string;
  materialId: string;
  /** Off when the user already exists (e.g. created by Better Auth sign-up). */
  createUser?: boolean;
}

/**
 * Test helper: enrolls a user in the placeholder `nkjv-cor` material,
 * optionally creating the user row first (for tests that don't sign up
 * via Better Auth).
 */
export function seedUserWithFixture(opts: SeedOptions): { snapshotId: string; version: number } {
  const { db, userId, materialId } = opts;
  const now = Math.floor(Date.now() / 1000);

  if (opts.createUser ?? true) createTestUser(db, userId);

  return enrollUser({ db, userId, materialId, now: () => now });
}

/** Signs up a user via Better Auth and seeds their enrollment — the
 *  boot shape the sync-flavoured suites share. Returns the session
 *  cookie + user id. */
export async function seedEnrolledUser(
  test: TestApp,
  email: string,
  materialId: string,
): Promise<{ cookie: string; userId: string }> {
  const { cookie, userId } = await signUpTestUser(test, email);
  seedUserWithFixture({ db: test.db, userId, materialId, createUser: false });
  return { cookie, userId };
}

/** A card id the material's max-emission config produces but `current`
 *  does not: the shape of a card the learner switched off. Throws if the
 *  deck has none, so a test relying on one cannot pass vacuously. */
export function switchedOffCardId(current: WasmEngine, materialId: string): number {
  const max = new WasmEngine(getMaterialJson(materialId), max_emission_config_json(), '', '[]', 0n);
  try {
    const renders = JSON.parse(max.all_card_renders()) as { cardId: number }[];
    const off = renders.find((r) => !current.has_card(r.cardId));
    if (off) return off.cardId;
  } finally {
    max.free();
  }
  throw new Error(`${materialId} has no card its current config switches off`);
}
