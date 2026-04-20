import { and, desc, eq } from 'drizzle-orm';
import { WasmEngine } from 'verse-vault-wasm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';

const DEFAULT_DESIRED_RETENTION = 0.9;

export interface EngineKey {
  userId: string;
  materialId: string;
}

export interface LoadedEngine {
  engine: WasmEngine;
  snapshotVersion: number;
}

/** Wire shapes for persisted state — must match the WASM boundary contract. */
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

/**
 * Loads and caches per-(user, material) WASM engines. The Node process is
 * long-running so engines stay in memory between requests — much faster than
 * reloading the graph on every session action.
 */
export class EngineStore {
  private readonly cache = new Map<string, LoadedEngine>();

  constructor(
    private readonly db: DB,
    private readonly desiredRetention: number = DEFAULT_DESIRED_RETENTION,
  ) {}

  async load(key: EngineKey): Promise<LoadedEngine> {
    const cached = this.cache.get(cacheKey(key));
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
      throw new Error(`No graph snapshot for user=${key.userId} material=${key.materialId}`);
    }

    const edges = this.db
      .select()
      .from(schema.edgeStates)
      .where(
        and(
          eq(schema.edgeStates.userId, key.userId),
          eq(schema.edgeStates.materialId, key.materialId),
        ),
      )
      .all();
    const cards = this.db
      .select()
      .from(schema.cardStates)
      .where(
        and(
          eq(schema.cardStates.userId, key.userId),
          eq(schema.cardStates.materialId, key.materialId),
        ),
      )
      .all();

    const edgeJson: EdgeStateEntry[] = edges.map((e) => ({
      edge_id: e.edgeId,
      stability: e.stability,
      difficulty: e.difficulty,
      last_review_secs: e.lastReviewSecs,
    }));
    const cardJson: CardStateEntry[] = cards.map((c) => ({
      card_id: c.cardId,
      state: c.state,
      due_r: c.dueR,
      due_date_secs: c.dueDateSecs,
      priority: c.priority,
    }));

    const engine = new WasmEngine(
      snapshot.graphData.toString('utf8'),
      snapshot.cardsData.toString('utf8'),
      JSON.stringify(edgeJson),
      JSON.stringify(cardJson),
      this.desiredRetention,
    );

    const loaded: LoadedEngine = { engine, snapshotVersion: snapshot.version };
    this.cache.set(cacheKey(key), loaded);
    return loaded;
  }

  invalidate(key: EngineKey): void {
    const k = cacheKey(key);
    const existing = this.cache.get(k);
    existing?.engine.free();
    this.cache.delete(k);
  }

  clear(): void {
    for (const loaded of this.cache.values()) loaded.engine.free();
    this.cache.clear();
  }
}

function cacheKey(k: EngineKey): string {
  return `${k.userId}:${k.materialId}`;
}
