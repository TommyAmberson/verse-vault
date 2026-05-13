import { and, desc, eq } from 'drizzle-orm';
import { WasmEngine } from 'verse-vault-wasm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { type UserMaterial, userMaterialKey } from './keys.js';

const DEFAULT_DESIRED_RETENTION = 0.9;

export type EngineKey = UserMaterial;

export interface LoadedEngine {
  engine: WasmEngine;
  snapshotVersion: number;
}

/** Thrown by `EngineStore.load` when the caller isn't enrolled in the material. */
export class NotEnrolledError extends Error {
  constructor(key: EngineKey) {
    super(`Not enrolled: user=${key.userId} material=${key.materialId}`);
    this.name = 'NotEnrolledError';
  }
}

/**
 * Wire shape mirrors `verse-vault-wasm` `TestStateEntry`. The `element` field
 * is the serde-tagged JSON form of `ElementId` (e.g. `{"kind":"Phrase",
 * "verse_id":0,"position":2}`); kept opaque on the API side and round-
 * tripped verbatim through the database. `test_kind` is one of the six
 * `TestKind` variants exposed by the core (PhraseFromContext,
 * VerseRefPosition, VerseChapter, VerseBook, VerseHeading, VerseClub).
 */
export interface TestStateEntry {
  element: unknown;
  test_kind: string;
  stability: number;
  difficulty: number;
  last_seen_secs: number;
  last_base_secs: number;
  last_root_secs: number;
}

/**
 * Build a JSON-encoded `MaterialConfig` for this user × material from the
 * picker tables. Absent rows imply defaults (everything-on, no paused
 * clubs). Returns the empty string when both tables are absent so the
 * WASM constructor uses `MaterialConfig::default()` directly.
 */
function readMaterialConfigJson(db: DB, key: EngineKey): string {
  const settings = db
    .select()
    .from(schema.userYearSettings)
    .where(
      and(
        eq(schema.userYearSettings.userId, key.userId),
        eq(schema.userYearSettings.materialId, key.materialId),
      ),
    )
    .get();
  const clubRows = db
    .select()
    .from(schema.userClubSettings)
    .where(
      and(
        eq(schema.userClubSettings.userId, key.userId),
        eq(schema.userClubSettings.materialId, key.materialId),
      ),
    )
    .all();

  if (!settings && clubRows.length === 0) return '';

  // Build the per-tier map MaterialConfig.clubs expects. Tiers missing
  // from the DB rows fall back to paused-with-cards-off via the core's
  // for_tier default, so we only emit entries for tiers the user has
  // touched. Status values are PascalCase to match the Rust enum.
  type RustStatus = 'Active' | 'Maintenance' | 'Paused';
  const TIER_KEY: Record<string, 'Club150' | 'Club300' | 'Full' | null> = {
    '150': 'Club150',
    '300': 'Club300',
    full: 'Full',
  };
  const STATUS_KEY: Record<string, RustStatus | null> = {
    active: 'Active',
    maintenance: 'Maintenance',
    paused: 'Paused',
  };
  const clubs: Record<string, { status: RustStatus; club_cards: boolean }> = {};
  for (const r of clubRows) {
    const tierKey = TIER_KEY[r.clubTier];
    const statusKey = STATUS_KEY[r.status];
    if (!tierKey || !statusKey) continue;
    clubs[tierKey] = { status: statusKey, club_cards: r.clubCards };
  }

  return JSON.stringify({
    headings: settings?.headings ?? true,
    ftv: settings?.ftv ?? true,
    clubs,
  });
}

export function readTestStateEntries(db: DB, key: EngineKey): TestStateEntry[] {
  return db
    .select()
    .from(schema.testStates)
    .where(
      and(eq(schema.testStates.userId, key.userId), eq(schema.testStates.materialId, key.materialId)),
    )
    .all()
    .map((r) => ({
      // `r.element` is a JSON-text column; parse it back into the tagged
      // ElementId object the WASM side expects.
      element: JSON.parse(r.element) as unknown,
      test_kind: r.testKind,
      stability: r.stability,
      difficulty: r.difficulty,
      last_seen_secs: r.lastSeenSecs,
      last_base_secs: r.lastBaseSecs,
      last_root_secs: r.lastRootSecs,
    }));
}

/**
 * Per-(user, material) engine cache + serialisation.
 *
 * Cache: WasmEngine instances live across requests so we don't re-parse the
 * MaterialData blob on every call.
 *
 * Serialisation: `WasmEngine.replay_event` is `&mut self` at the WASM
 * boundary. Two concurrent reviews for the same (user, material) — e.g.
 * a fast double-click — must not interleave their mutate-then-export
 * sequences, since that races the order of upserts against `timestamp_secs`.
 * `withLock` queues callers per key on a tail Promise; cheap and good
 * enough for single-tab usage.
 */
export class EngineStore {
  private readonly cache = new Map<string, LoadedEngine>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: DB,
    private readonly desiredRetention: number = DEFAULT_DESIRED_RETENTION,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async load(key: EngineKey): Promise<LoadedEngine> {
    const cached = this.cache.get(userMaterialKey(key));
    if (cached) return cached;

    const snapshot = this.db
      .select()
      .from(schema.graphSnapshots)
      .where(
        and(
          eq(schema.graphSnapshots.userId, key.userId),
          eq(schema.graphSnapshots.materialId, key.materialId),
        ),
      )
      .orderBy(desc(schema.graphSnapshots.version))
      .limit(1)
      .get();
    if (!snapshot) {
      throw new NotEnrolledError(key);
    }

    const testStates = readTestStateEntries(this.db, key);
    const materialJson = snapshot.materialData.toString('utf8');
    const configJson = readMaterialConfigJson(this.db, key);
    const engine = new WasmEngine(
      materialJson,
      configJson,
      JSON.stringify(testStates),
      this.desiredRetention,
      BigInt(this.now()),
    );

    const loaded: LoadedEngine = { engine, snapshotVersion: snapshot.version };
    this.cache.set(userMaterialKey(key), loaded);
    return loaded;
  }

  /**
   * Drop the cached engine for this key. The next `load` rebuilds from
   * fresh DB state — used after material-picker writes change either the
   * per-year toggles or the per-club paused set.
   */
  invalidate(key: EngineKey): void {
    const k = userMaterialKey(key);
    const cached = this.cache.get(k);
    if (cached) {
      cached.engine.free();
      this.cache.delete(k);
    }
  }

  /**
   * Run `fn` exclusively against the (user, material) engine. Concurrent
   * callers queue on the tail promise so engine mutations + their DB
   * upserts apply in submission order. Doesn't catch errors — fn rejection
   * is propagated to the caller while the lock advances normally.
   */
  async withLock<T>(key: EngineKey, fn: () => Promise<T>): Promise<T> {
    const k = userMaterialKey(key);
    const prev = this.tails.get(k) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(
      k,
      next.catch(() => {}),
    );
    return next;
  }

  clear(): void {
    for (const loaded of this.cache.values()) loaded.engine.free();
    this.cache.clear();
    this.tails.clear();
  }
}
