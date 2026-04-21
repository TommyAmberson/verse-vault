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

/** Wire shapes must stay in sync with crates/wasm/src/lib.rs. */
export interface EdgeStateEntry {
  edge_id: number;
  stability: number;
  difficulty: number;
  last_review_secs: number;
}

export interface CardStateEntry {
  card_id: number;
  state: 'new' | 'learning' | 'review' | 'relearning';
  due_r: number | null;
  due_date_secs: number | null;
  priority: number | null;
}

export function readEdgeStateEntries(db: DB, key: EngineKey): EdgeStateEntry[] {
  return db
    .select()
    .from(schema.edgeStates)
    .where(
      and(eq(schema.edgeStates.userId, key.userId), eq(schema.edgeStates.materialId, key.materialId)),
    )
    .all()
    .map((e) => ({
      edge_id: e.edgeId,
      stability: e.stability,
      difficulty: e.difficulty,
      last_review_secs: e.lastReviewSecs,
    }));
}

export function readCardStateEntries(db: DB, key: EngineKey): CardStateEntry[] {
  return db
    .select()
    .from(schema.cardStates)
    .where(
      and(eq(schema.cardStates.userId, key.userId), eq(schema.cardStates.materialId, key.materialId)),
    )
    .all()
    .map((c) => ({
      card_id: c.cardId,
      state: c.state,
      due_r: c.dueR,
      due_date_secs: c.dueDateSecs,
      priority: c.priority,
    }));
}

/** Long-running Node process, so engines live across requests; no eviction yet. */
export class EngineStore {
  private readonly cache = new Map<string, LoadedEngine>();

  constructor(
    private readonly db: DB,
    private readonly desiredRetention: number = DEFAULT_DESIRED_RETENTION,
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

    const edgeJson = readEdgeStateEntries(this.db, key);
    const cardJson = readCardStateEntries(this.db, key);

    const engine = new WasmEngine(
      snapshot.graphData.toString('utf8'),
      snapshot.cardsData.toString('utf8'),
      JSON.stringify(edgeJson),
      JSON.stringify(cardJson),
      this.desiredRetention,
    );

    const loaded: LoadedEngine = { engine, snapshotVersion: snapshot.version };
    this.cache.set(userMaterialKey(key), loaded);
    return loaded;
  }

  invalidate(key: EngineKey): void {
    const k = userMaterialKey(key);
    this.cache.get(k)?.engine.free();
    this.cache.delete(k);
  }

  clear(): void {
    for (const loaded of this.cache.values()) loaded.engine.free();
    this.cache.clear();
  }
}
