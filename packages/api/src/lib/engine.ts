import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq } from 'drizzle-orm';
import { WasmEngine } from 'verse-vault-wasm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { type Grade, writeTestStates } from './review-log.js';
import { type UserMaterial, userMaterialKey } from './keys.js';
import { getMaterialJson } from './materials.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Memoise SHA over JSON content. Keyed by the string itself, so a
 *  different blob gets a different entry (the materialId-keyed variant
 *  would be wrong under any test or hot-reload that swaps content for
 *  the same id). Bounded by the number of distinct blobs ever seen
 *  per process — small. */
const sha256Cache = new Map<string, string>();

function sha256Memo(json: string): string {
  let h = sha256Cache.get(json);
  if (!h) {
    h = sha256(json);
    sha256Cache.set(json, h);
  }
  return h;
}

/** Latest stored snapshot row for the (user, material) pair, or
 *  `undefined` when the user isn't enrolled. Shared by `EngineStore.load`,
 *  the test-state adapter, and the `/state` sync endpoint so the
 *  desc-version pick stays consistent across call sites. */
export function getLatestSnapshot(db: DB, key: EngineKey) {
  return db
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
}

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
  /** Sticky after a card was graded Again; the relearning lane re-surfaces
   *  these tests' cards. Cleared on any non-Again grade. */
  pending_relearn: boolean;
}

/**
 * Build a JSON-encoded `MaterialConfig` for this user × material from
 * the picker table. No row means defaults (the WASM constructor uses
 * `MaterialConfig::default()` directly when we return the empty string).
 *
 * The DB stores scope values in the same camelCase form (`off` / `up150`
 * / `up300` / `all`) that the Rust enums declare via
 * `#[serde(rename_all = "camelCase")]`, so the values pass through with
 * no translation step.
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

  if (!settings) return '';

  return JSON.stringify({
    headings: settings.headings,
    ftv: settings.ftv,
    new_scope: settings.newScope,
    review_scope: settings.reviewScope,
    club_card_scope: settings.clubCardScope,
    chapter_list_scope: settings.chapterListScope,
  });
}

/** Cumulative-sum half-open word ranges per phrase, keyed by verse_id.
 *  verse_id is the index into `verses_with_content()` order — verses
 *  with empty `phraseWordCounts` are skipped, matching Rust's iterator. */
function computePhraseRangesByVerse(
  materialJson: string,
): Map<number, [number, number][]> {
  const m = JSON.parse(materialJson) as {
    verses?: { phraseWordCounts?: number[] }[];
  };
  const ranges = new Map<number, [number, number][]>();
  let verseId = 0;
  for (const v of m.verses ?? []) {
    const counts = v.phraseWordCounts;
    if (!counts || counts.length === 0) continue;
    const r: [number, number][] = [];
    let cursor = 0;
    for (const n of counts) {
      const next = cursor + n;
      r.push([cursor, next]);
      cursor = next;
    }
    ranges.set(verseId, r);
    verseId += 1;
  }
  return ranges;
}

/** Translate a stored `Phrase` element from the legacy positional form
 *  to the content-stable range form using the verse's phrase ranges.
 *  Non-Phrase elements pass through untouched. Returns null when the
 *  position no longer maps to any phrase range (verse removed or
 *  shrunk past this position) — caller should drop the row. */
function adaptElement(
  element: unknown,
  phraseRangesByVerse: Map<number, [number, number][]>,
): unknown | null {
  if (typeof element !== 'object' || element === null) return element;
  const obj = element as Record<string, unknown>;
  if (obj.kind !== 'Phrase' || !('position' in obj)) return element;
  const verseId = obj.verse_id as number;
  const position = obj.position as number;
  const range = phraseRangesByVerse.get(verseId)?.[position];
  if (!range) return null;
  return {
    kind: 'Phrase',
    verse_id: verseId,
    start_word: range[0],
    end_word: range[1],
  };
}

/** Load test_states for the user and translate any legacy positional
 *  Phrase elements to the new range identity. Pass `materialJson` when
 *  the caller already has the snapshot in hand (e.g. `EngineStore.load`)
 *  to skip a redundant snapshot read; otherwise it's fetched here. */
export function readTestStateEntries(
  db: DB,
  key: EngineKey,
  materialJson?: string,
): TestStateEntry[] {
  const json = materialJson ?? getLatestSnapshot(db, key)?.materialData.toString('utf8');
  const phraseRangesByVerse = json
    ? computePhraseRangesByVerse(json)
    : new Map<number, [number, number][]>();
  return db
    .select()
    .from(schema.testStates)
    .where(
      and(eq(schema.testStates.userId, key.userId), eq(schema.testStates.materialId, key.materialId)),
    )
    .all()
    .flatMap((r) => {
      const element = adaptElement(JSON.parse(r.element), phraseRangesByVerse);
      if (element === null) return [];
      return [
        {
          element,
          test_kind: r.testKind,
          stability: r.stability,
          difficulty: r.difficulty,
          last_seen_secs: r.lastSeenSecs,
          last_base_secs: r.lastBaseSecs,
          last_root_secs: r.lastRootSecs,
          pending_relearn: r.pendingRelearn !== 0,
        },
      ];
    });
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
    /** Source of the bundled MaterialData JSON, by material id. Tests
     *  inject a stub to drive snapshot-bump scenarios; production
     *  defaults to the on-disk loader. */
    private readonly loadBundledJson: (id: string) => string = getMaterialJson,
  ) {}

  async load(key: EngineKey): Promise<LoadedEngine> {
    // Detect content updates before consulting the cache: bundled
    // materialData changes need to bump the user's snapshot and drop
    // any stale in-memory engine. Otherwise existing users would never
    // see edits to data/<year>.json after their first enrollment.
    let snapshot = getLatestSnapshot(this.db, key);
    if (!snapshot) throw new NotEnrolledError(key);

    const bundledJson = this.loadBundledJson(key.materialId);
    if (sha256Memo(bundledJson) !== sha256Memo(snapshot.materialData.toString('utf8'))) {
      const newId = randomUUID();
      const newVersion = snapshot.version + 1;
      const createdAt = this.now();
      this.db
        .insert(schema.graphSnapshots)
        .values({
          id: newId,
          userId: key.userId,
          materialId: key.materialId,
          version: newVersion,
          materialData: Buffer.from(bundledJson, 'utf8'),
          createdAt,
        })
        .run();
      this.invalidate(key);
      snapshot = {
        ...snapshot,
        id: newId,
        version: newVersion,
        materialData: Buffer.from(bundledJson, 'utf8'),
        createdAt,
      };
    }

    const cached = this.cache.get(userMaterialKey(key));
    if (cached) return cached;

    const materialJson = snapshot.materialData.toString('utf8');
    const testStates = readTestStateEntries(this.db, key, materialJson);
    const configJson = readMaterialConfigJson(this.db, key);
    const engine = new WasmEngine(
      materialJson,
      configJson,
      JSON.stringify(testStates),
      this.desiredRetention,
      BigInt(this.now()),
    );

    // Cards built from MaterialData start as `New`; apply every recorded
    // graduation so the in-memory engine matches the user's actual progress.
    const graduated = this.db
      .select({ verseId: schema.graduatedVerses.verseId })
      .from(schema.graduatedVerses)
      .where(
        and(
          eq(schema.graduatedVerses.userId, key.userId),
          eq(schema.graduatedVerses.materialId, key.materialId),
        ),
      )
      .all();
    for (const { verseId } of graduated) {
      engine.graduate_verse(verseId);
    }

    const loaded: LoadedEngine = { engine, snapshotVersion: snapshot.version };
    this.cache.set(userMaterialKey(key), loaded);
    return loaded;
  }

  /**
   * Drop the in-memory engine and recompute test_states from the full
   * event log. Used by the sync handler when an incoming batch carries
   * events older than what's already been applied for the same card —
   * FSRS state is order-sensitive, so the only way to get the right
   * result is to replay from scratch in (timestampSecs, clientEventId)
   * order.
   *
   * The reviewEvents table is the source of truth; testStates is a
   * materialised view that this method drops and rewrites. Callers
   * MUST hold the per-key lock (via `withLock`) so the rebuild's
   * delete-then-insert pass doesn't race a concurrent review.
   */
  rebuildFromEvents(key: EngineKey): LoadedEngine {
    const snapshot = getLatestSnapshot(this.db, key);
    if (!snapshot) throw new NotEnrolledError(key);

    const materialJson = snapshot.materialData.toString('utf8');
    const configJson = readMaterialConfigJson(this.db, key);
    const engine = new WasmEngine(
      materialJson,
      configJson,
      // Empty persisted states — we'll replay the full log on top.
      '[]',
      this.desiredRetention,
      BigInt(this.now()),
    );

    // Graduations live outside reviewEvents; apply them upfront so the
    // rebuilt engine's card-lifecycle state matches what a fresh
    // EngineStore.load() would produce (which also applies graduations
    // after constructor init). `replay_event` itself is
    // lifecycle-agnostic — it works on New cards too — so ordering
    // matters for parity with the live-load path, not correctness.
    const graduated = this.db
      .select({ verseId: schema.graduatedVerses.verseId })
      .from(schema.graduatedVerses)
      .where(
        and(
          eq(schema.graduatedVerses.userId, key.userId),
          eq(schema.graduatedVerses.materialId, key.materialId),
        ),
      )
      .all();
    for (const { verseId } of graduated) {
      engine.graduate_verse(verseId);
    }

    // Chronological replay. Tiebreak on clientEventId so two events with
    // identical timestampSecs produce a deterministic ordering — same
    // tiebreak the sync POST handler uses for the in-order path.
    const events = this.db
      .select({
        cardId: schema.reviewEvents.cardId,
        grade: schema.reviewEvents.grade,
        timestampSecs: schema.reviewEvents.timestampSecs,
        clientEventId: schema.reviewEvents.clientEventId,
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
    for (const e of events) {
      engine.replay_event(e.cardId, e.grade as Grade, BigInt(e.timestampSecs));
    }

    const rebuiltStates = JSON.parse(engine.export_test_states()) as TestStateEntry[];
    this.db.transaction((tx) => {
      tx.delete(schema.testStates)
        .where(
          and(
            eq(schema.testStates.userId, key.userId),
            eq(schema.testStates.materialId, key.materialId),
          ),
        )
        .run();
      writeTestStates(tx, key.userId, key.materialId, rebuiltStates, { onConflict: false });
    });

    // Replace the cached engine. invalidate() frees the old one if any.
    this.invalidate(key);
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
