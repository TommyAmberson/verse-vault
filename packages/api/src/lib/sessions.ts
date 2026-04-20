import { randomUUID } from 'node:crypto';

import type { WasmEngine } from 'verse-vault-wasm';

export interface SessionCard {
  shown: number[];
  hidden: number[];
  is_reading: boolean;
  source_kind: 'scheduled' | 'redrill' | 'new_verse';
  source_card_id: number | null;
}

export interface SessionEntry {
  id: string;
  userId: string;
  materialId: string;
  snapshotVersion: number;
  engine: WasmEngine;
  createdAtSecs: number;
  /** Card currently awaiting a review. Populated by `advance()`, consumed by review. */
  currentCard: SessionCard | null;
}

/**
 * In-memory registry of active sessions. A WasmEngine can hold at most one
 * session at a time, so we also track the current session per (user, material)
 * and abort it when a new one is started.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly activeByUserMaterial = new Map<string, string>();

  create(args: {
    userId: string;
    materialId: string;
    snapshotVersion: number;
    engine: WasmEngine;
    nowSecs: number;
  }): SessionEntry {
    const prevId = this.activeByUserMaterial.get(userMaterialKey(args));
    if (prevId) this.end(prevId);

    const id = randomUUID();
    const entry: SessionEntry = {
      id,
      userId: args.userId,
      materialId: args.materialId,
      snapshotVersion: args.snapshotVersion,
      engine: args.engine,
      createdAtSecs: args.nowSecs,
      currentCard: null,
    };
    this.sessions.set(id, entry);
    this.activeByUserMaterial.set(userMaterialKey(args), id);
    return entry;
  }

  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  end(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    const key = userMaterialKey(entry);
    if (this.activeByUserMaterial.get(key) === id) {
      this.activeByUserMaterial.delete(key);
    }
  }
}

function userMaterialKey(x: { userId: string; materialId: string }): string {
  return `${x.userId}:${x.materialId}`;
}
