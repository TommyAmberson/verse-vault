import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq } from 'drizzle-orm';
import { WasmEngine } from 'verse-vault-wasm';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { type Grade, writeTestStates } from './review-log.js';
import { type UserMaterial, userMaterialKey } from './keys.js';
import { getMaterialJson } from './materials.js';
import {
  downgradeScheduleToV1WireFormat,
  loadSchedule,
  migrateSchedule,
} from './schedules.js';
import { legacyToNew, type YearSettings } from './year-settings.js';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Returns the bundled JSON for `materialId` if it can be loaded, else
 *  `undefined`. Used by readers (e.g. `readTestStateEntries`) that may
 *  run for materials whose disk file is missing or has been renamed —
 *  rather than crashing the whole request, fall back to whatever state
 *  the DB can produce without the materialData.
 *
 *  `EngineStore.rebuildFromEvents` deliberately does NOT use this helper —
 *  without materialJson it can't construct a WasmEngine at all, so
 *  failing loudly is correct there. */
function safeLoadMaterialJson(materialId: string): string | undefined {
  try {
    return getMaterialJson(materialId);
  } catch {
    return undefined;
  }
}

/** Load the user's (or bundled) schedule and normalise it to the v1 wire
 *  form the WASM engine understands today. Persisted rows may be v1 or v2
 *  (`week.blocks[]`) after the schedule-editor redesign — `migrateSchedule`
 *  converges both onto v2 in memory, then `downgradeScheduleToV1WireFormat`
 *  serialises back to v1 for the engine boundary. Multi-passage weeks
 *  (`blocks.length > 1`) are rejected here with a clear error until the
 *  Rust contract crate learns to consume them (spec §7, phase 6). */
function loadScheduleForEngine(db: DB, userId: string, materialId: string): string {
  const raw = loadSchedule(db, userId, materialId);
  if (raw === '') return '';
  return downgradeScheduleToV1WireFormat(migrateSchedule(JSON.parse(raw)));
}

/** Detect the per-(user, material, version) UNIQUE constraint violation
 *  that fires when two concurrent `EngineStore.load` calls race the
 *  bump-on-load insert. better-sqlite3 surfaces the failure as an
 *  Error whose `code` is `SQLITE_CONSTRAINT_UNIQUE` and whose message
 *  names the offending index. */
function isVersionUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof e.message === 'string' &&
    e.message.includes('uniq_graph_snapshots_user_material_version')
  );
}

/** Memoise SHA over JSON content. Keyed by the string itself, so a
 *  different blob gets a different entry (the materialId-keyed variant
 *  would be wrong under any test or hot-reload that swaps content for
 *  the same id). Bounded by the number of distinct blobs ever seen
 *  per process — small. */
const sha256Cache = new Map<string, string>();

/** SHA-256 hex digest with a process-wide memo. Exported so the
 *  enrollment path can share the cache: a freshly-enrolled user's
 *  first `EngineStore.load` will hit the memo from the enrollment-
 *  time hash rather than re-hashing the same bytes. */
export function sha256Memo(json: string): string {
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

export type EngineKey = UserMaterial;

/** Reference-counted handle returned by `EngineStore.load`. Implements
 *  `Symbol.dispose` so callers use `using` to bind it:
 *
 *      using loaded = await engines.load(key);
 *      loaded.engine.next_review_card(...);
 *
 *  The cache entry's refcount tracks live handles; eviction queues the
 *  entry but `engine.free()` doesn't fire until both the grace period
 *  elapses AND refcount reaches zero. Holding a handle across a slow
 *  `await` is safe — the WASM heap is pinned until dispose. */
export interface LoadedEngine extends Disposable {
  readonly engine: WasmEngine;
  readonly snapshotVersion: number;
}

/** Internal cache entry. The refcount tracks outstanding `LoadedEngine`
 *  handles returned from `load`; eviction can move an entry to
 *  `pendingFree`, but `drainPendingFree` won't call `engine.free()` until
 *  refcount drops to zero. */
interface CacheEntry {
  engine: WasmEngine;
  snapshotVersion: number;
  refcount: number;
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

/** State payload embedded in `TestUpdateWire.before` / `.after`. Same
 *  fields as `TestStateEntry` minus the `element` + `test_kind` key
 *  (which live on `TestUpdateWire.key`). Wire shape mirrors the Rust
 *  `verse-vault-core::TestState`. `pending_relearn` is always emitted
 *  because no field carries `#[serde(skip_serializing_if)]`
 *  (`#[serde(default)]` on the Rust side governs the *deserialization*
 *  direction only — it doesn't suppress emission). If a future
 *  contributor adds `skip_serializing_if` to trim wire size, this
 *  type and `changedStatesFromUpdates` will silently drop the field
 *  on the persist path — guard with a test, not a comment.
 *
 *  Defined as a `Pick` so a future core field added to `TestState`
 *  shows up structurally on both sides without manual sync. */
export type TestUpdateState = Pick<
  TestStateEntry,
  | 'stability'
  | 'difficulty'
  | 'last_seen_secs'
  | 'last_base_secs'
  | 'last_root_secs'
  | 'pending_relearn'
>;

/** Wire-format mirror of `verse-vault-core::TestUpdate`. Emitted by
 *  `WasmEngine.replay_event(...)`. `kind` is the update flavour
 *  (`Root` for atomic-card full FSRS step, `Sub` for composite-card
 *  Bayesian-share sub-update). `key` identifies which test was touched
 *  and round-trips through the database opaquely. */
export interface TestUpdateWire {
  key: { kind: string; element: unknown };
  kind: 'Root' | 'Sub';
  before: TestUpdateState;
  after: TestUpdateState;
}

/** Convert one-or-more `replay_event` returns into the
 *  `TestStateEntry[]` shape that `writeTestStates` consumes. Reads
 *  each touched test's post-update state straight from `update.after`,
 *  bypassing the prior full-catalog `export_test_states()` + filter.
 *
 *  Within a single `replay_event` call the core never emits duplicate
 *  keys — atomic cards return 1 update for 1 key, composite cards
 *  return N updates for N distinct contained tests (Bayesian
 *  decomposition; see `crates/core/src/engine.rs`). Duplicates only
 *  arise when sync.ts replays several events touching the same test
 *  in one batch; those events were sorted by
 *  `(timestampSecs, clientEventId)` before replay, so the
 *  chronologically last update is the most recent. Map-based
 *  last-write-wins preserves that order and matches the final cached
 *  engine state byte-for-byte.
 *
 *  Element-key dedup is order-insensitive: `canonicalizeKey` sorts
 *  fields recursively before serialising, so two `ElementId` objects
 *  carrying the same fields in different insertion order collapse to
 *  one map entry. Today's only producer is Rust serde (stable field
 *  order), but the helper is exported as a public surface and a
 *  future TS caller could feed in elements built field-by-field. */
export function changedStatesFromUpdates(updates: TestUpdateWire[]): TestStateEntry[] {
  const byKey = new Map<string, TestStateEntry>();
  for (const u of updates) {
    const k = `${u.key.kind}|${canonicalizeKey(u.key.element)}`;
    byKey.set(k, {
      element: u.key.element,
      test_kind: u.key.kind,
      stability: u.after.stability,
      difficulty: u.after.difficulty,
      last_seen_secs: u.after.last_seen_secs,
      last_base_secs: u.after.last_base_secs,
      last_root_secs: u.after.last_root_secs,
      pending_relearn: u.after.pending_relearn,
    });
  }
  return Array.from(byKey.values());
}

/** Order-insensitive serialisation for use as a dedup key. Sorts object
 *  fields recursively so `{a, b}` and `{b, a}` hash to the same string.
 *  Arrays preserve order (positional semantics). Scalars passthrough.
 *  Not for cryptographic use; not safe against cyclic structures (none
 *  reach here — `ElementId` is an enum of finite-depth POD variants). */
function canonicalizeKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeKey).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalizeKey(obj[k])}`);
  return `{${parts.join(',')}}`;
}

// `readDesiredRetention` was removed in Phase 1 — target retention is
// per-club inside `MaterialConfig.review.{club}.desiredRetention`, read
// from `config_json` by `readMaterialConfigJson`. The legacy
// `user_year_settings.desired_retention` column still receives writes
// during the dual-shape transition but no longer drives the engine.

/**
 * Build a JSON-encoded `MaterialConfig` for this user × material from
 * the picker table.
 *
 * As of Phase 1: prefer the per-club `config_json` blob (written
 * verbatim by the route layer for both shape-paths); fall back to
 * synthesising the per-club shape from the legacy columns when
 * `config_json` is NULL (pre-migration rows the user hasn't touched
 * yet). No row → empty string → WASM uses the legacy "everything on"
 * fallback inside `parse_material_config('')`.
 *
 * The synthesised path mirrors `legacyToNew` so route writes and
 * engine reads agree on the per-club semantics. The wire form
 * matches `crates/core@0.6.0`'s `MaterialConfig` accept-either-shape
 * deserialiser (snake_case for the legacy fields; camelCase for the
 * new per-club fields).
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

  // Phase 1 happy path: use the per-club blob materialised by migration
  // 0023 and re-written by the route on every save. Verbatim pass-
  // through — the engine parses it as the new shape.
  if (settings.configJson !== null && settings.configJson !== '') {
    return settings.configJson;
  }

  // Fallback: synthesise the per-club shape from the legacy columns for
  // any row where config_json hasn't been populated yet. Delegates to
  // `legacyToNew` so the migration table (scope ladders → per-club
  // booleans, retention clamp into [0.5, 0.9], default catch_up + gates)
  // lives in exactly one place.
  return JSON.stringify(legacyToNew(settings as YearSettings));
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
/** Verse ids the user has graduated for this material. Used both
 *  inside EngineStore (to flip cards to Active after engine
 *  construction) and by the sync /state handler (so the client can
 *  re-apply graduations after a fresh build). */
export function readGraduatedVerseIds(db: DB, key: EngineKey): number[] {
  return db
    .select({ verseId: schema.graduatedVerses.verseId })
    .from(schema.graduatedVerses)
    .where(
      and(
        eq(schema.graduatedVerses.userId, key.userId),
        eq(schema.graduatedVerses.materialId, key.materialId),
      ),
    )
    .all()
    .map((r) => r.verseId);
}

/** Card ids the user has graduated individually for this material —
 *  HeadingPassage, ChapterClubList, and the conditional verse-bound
 *  kinds that don't ride along with `graduate_verse`. Replayed by
 *  `EngineStore.load` + `rebuildFromEvents` alongside the verse
 *  graduations, and surfaced on the sync /state response so fat
 *  clients can replay the same way after a fresh build. */
export function readGraduatedCardIds(db: DB, key: EngineKey): number[] {
  return db
    .select({ cardId: schema.graduatedCards.cardId })
    .from(schema.graduatedCards)
    .where(
      and(
        eq(schema.graduatedCards.userId, key.userId),
        eq(schema.graduatedCards.materialId, key.materialId),
      ),
    )
    .all()
    .map((r) => r.cardId);
}

export function readTestStateEntries(
  db: DB,
  key: EngineKey,
  materialJson?: string,
): TestStateEntry[] {
  // materialJson is provided by every production caller (`EngineStore.load`
  // builds it from disk before this runs). The disk fallback covers tests
  // that call `readTestStateEntries` directly without going through the
  // engine. Falls back to enrollment for unknown materialIds — `null` for
  // genuinely unrecognised ones, which means the phrase-range map is empty
  // and adaptElement drops any legacy positional rows.
  const json = materialJson ?? safeLoadMaterialJson(key.materialId);
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

export interface EvictionOptions {
  /** Hard cap on cached engines. The least-recently-used entry is
   *  evicted to make room when a `load()` would otherwise exceed this.
   *  Sized as a safety net for unexpected concurrent peaks; the idle
   *  TTL does the day-to-day cleanup. */
  maxEntries?: number;
  /** Cached engines whose last use is older than this many seconds are
   *  evicted on the next reaper tick. Should comfortably exceed a
   *  typical visit duration (so we don't churn mid-session) while
   *  staying well below the inter-visit gap (so dormant users don't
   *  pile up in RAM). */
  idleTtlSecs?: number;
  /** How often the reaper walks the cache. */
  reaperIntervalSecs?: number;
}

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_IDLE_TTL_SECS = 7200;
const DEFAULT_REAPER_INTERVAL_SECS = 60;

/** Evicted engines wait this long before `engine.free()` is called on
 *  them. Bridges in-flight requests that captured a `LoadedEngine`
 *  reference before eviction so their next `engine.method()` call
 *  doesn't hit a freed WASM handle. The longest realistic request path
 *  (api.bible cache fetch + DB transaction) comfortably fits in 30 s. */
const PENDING_FREE_GRACE_SECS = 30;

/**
 * Per-(user, material) engine cache + serialisation.
 *
 * Cache: WasmEngine instances live across requests so we don't re-parse the
 * MaterialData blob on every call. Bounded by an LRU cap + idle TTL —
 * see `EvictionOptions`. The reaper has to be started explicitly via
 * `start()` so tests can drive eviction synchronously via `reap()`.
 *
 * Serialisation: `WasmEngine.replay_event` is `&mut self` at the WASM
 * boundary. Two concurrent reviews for the same (user, material) — e.g.
 * a fast double-click — must not interleave their mutate-then-export
 * sequences, since that races the order of upserts against `timestamp_secs`.
 * `withLock` queues callers per key on a tail Promise; cheap and good
 * enough for single-tab usage.
 */
export class EngineStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastUsedAt = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Entries that have left the cache but whose `engine.free()` is
   *  deferred until **both** the grace period elapses **and** their
   *  refcount drops to zero. Two safety mechanisms in one queue:
   *  refcount tracks live `LoadedEngine` handles (request-scoped), the
   *  grace period catches handles that escape — e.g. a future code
   *  change that stashes a `LoadedEngine` somewhere it shouldn't. */
  private readonly pendingFree: { entry: CacheEntry; evictedAt: number }[] = [];
  private reaperHandle: NodeJS.Timeout | null = null;
  private readonly maxEntries: number;
  private readonly idleTtlSecs: number;
  private readonly reaperIntervalSecs: number;

  constructor(
    private readonly db: DB,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    /** Source of the bundled MaterialData JSON, by material id. Tests
     *  inject a stub to drive snapshot-bump scenarios; production
     *  defaults to the on-disk loader. */
    private readonly loadBundledJson: (id: string) => string = getMaterialJson,
    options: EvictionOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.idleTtlSecs = options.idleTtlSecs ?? DEFAULT_IDLE_TTL_SECS;
    this.reaperIntervalSecs = options.reaperIntervalSecs ?? DEFAULT_REAPER_INTERVAL_SECS;
  }

  /**
   * Resolve the cached engine for `(user, material)`, building it from
   * disk on a cold miss. Returns a `LoadedEngine` handle that pins the
   * underlying `WasmEngine` against deferred-free for as long as the
   * handle is alive — callers MUST bind it with `using` so dispose
   * fires at scope exit:
   *
   *     using loaded = await engines.load(key);
   *     loaded.engine.next_review_card(...);
   */
  async load(key: EngineKey): Promise<LoadedEngine> {
    // Detect content updates before consulting the cache: a changed
    // disk JSON needs to bump the user's snapshot and drop any stale
    // in-memory engine. Otherwise existing users would never see edits
    // to data/<year>.json after their first enrollment.
    let snapshot = getLatestSnapshot(this.db, key);
    if (!snapshot) throw new NotEnrolledError(key);

    const bundledJson = this.loadBundledJson(key.materialId);
    const bundledSha = sha256Memo(bundledJson);
    if (bundledSha !== snapshot.contentSha) {
      const newId = randomUUID();
      const newVersion = snapshot.version + 1;
      const createdAt = this.now();
      try {
        this.db
          .insert(schema.graphSnapshots)
          .values({
            id: newId,
            userId: key.userId,
            materialId: key.materialId,
            version: newVersion,
            contentSha: bundledSha,
            createdAt,
          })
          .run();
        this.invalidate(key);
        snapshot = {
          ...snapshot,
          id: newId,
          version: newVersion,
          contentSha: bundledSha,
          createdAt,
        };
      } catch (err) {
        // Concurrent loads on the same (user, material) at bump time
        // race the `uniq_graph_snapshots_user_material_version` insert.
        // The winner already wrote the row we'd have written; re-fetch
        // and continue with that row. Anything other than a UNIQUE
        // violation propagates.
        if (!isVersionUniqueViolation(err)) throw err;
        const latest = getLatestSnapshot(this.db, key);
        if (!latest) throw err;
        this.invalidate(key);
        snapshot = latest;
      }
    }

    const k = userMaterialKey(key);
    const cached = this.cache.get(k);
    if (cached) {
      this.lastUsedAt.set(k, this.now());
      return this.acquire(cached);
    }

    const materialJson = bundledJson;
    const testStates = readTestStateEntries(this.db, key, materialJson);
    const configJson = readMaterialConfigJson(this.db, key);
    const scheduleJson = loadScheduleForEngine(this.db, key.userId, key.materialId);
    const engine = new WasmEngine(
      materialJson,
      configJson,
      scheduleJson,
      JSON.stringify(testStates),
      BigInt(this.now()),
    );

    // Cards built from MaterialData start as `New`; apply every recorded
    // graduation so the in-memory engine matches the user's actual progress.
    // Verse-bulk first, then per-card — order doesn't matter for state
    // (graduate_card is a single-card no-op once Active) but it mirrors
    // the persistence ordering.
    for (const verseId of readGraduatedVerseIds(this.db, key)) {
      engine.graduate_verse(verseId);
    }
    for (const cardId of readGraduatedCardIds(this.db, key)) {
      engine.graduate_card(cardId);
    }

    return this.cacheInsert(k, { engine, snapshotVersion: snapshot.version, refcount: 0 });
  }

  /** Convenience wrapper that returns `null` instead of throwing
   *  `NotEnrolledError`. Lets route handlers handle the not-enrolled
   *  case with a guard + early-return before binding the result to a
   *  `using` declaration:
   *
   *      const raw = await engines.tryLoad(key);
   *      if (raw === null) return c.json({ error: 'Not enrolled' }, 404);
   *      using loaded = raw;
   *      loaded.engine.next_review_card(...);
   */
  async tryLoad(key: EngineKey): Promise<LoadedEngine | null> {
    try {
      return await this.load(key);
    } catch (err) {
      if (err instanceof NotEnrolledError) return null;
      throw err;
    }
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

    // Use the current disk content; if it has drifted from snapshot.contentSha
    // since the last load, replay against the new content. adaptElement
    // inside readTestStateEntries handles known structural transforms.
    const materialJson = this.loadBundledJson(key.materialId);
    const configJson = readMaterialConfigJson(this.db, key);
    const scheduleJson = loadScheduleForEngine(this.db, key.userId, key.materialId);
    const engine = new WasmEngine(
      materialJson,
      configJson,
      scheduleJson,
      // Empty persisted states — we'll replay the full log on top.
      '[]',
      BigInt(this.now()),
    );

    // Graduations live outside reviewEvents; apply them upfront so the
    // rebuilt engine's card-lifecycle state matches what a fresh
    // EngineStore.load() would produce (which also applies graduations
    // after constructor init). `replay_event` itself is
    // lifecycle-agnostic — it works on New cards too — so ordering
    // matters for parity with the live-load path, not correctness.
    for (const verseId of readGraduatedVerseIds(this.db, key)) {
      engine.graduate_verse(verseId);
    }
    for (const cardId of readGraduatedCardIds(this.db, key)) {
      engine.graduate_card(cardId);
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

    // Replace the cached engine. invalidate() defers free on the old one if any.
    this.invalidate(key);
    return this.cacheInsert(userMaterialKey(key), {
      engine,
      snapshotVersion: snapshot.version,
      refcount: 0,
    });
  }

  /**
   * Drop the cached engine for this key. The next `load` rebuilds from
   * fresh DB state — used after material-picker writes change either the
   * per-year toggles or the per-club paused set.
   *
   * Routes through `evictToPending` so the old engine sits in the
   * deferred-free queue rather than being released synchronously.
   * Matches the LRU + TTL eviction paths and removes a load-bearing
   * "every caller holds withLock" convention from the contract — a
   * future request handler that holds a `LoadedEngine` reference
   * across an await won't crash on the next `engine.method()` call if
   * a settings change invalidates the entry in the meantime.
   */
  invalidate(key: EngineKey): void {
    this.evictToPending(userMaterialKey(key));
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

  /** Start the background idle reaper. Idempotent. Production calls
   *  this from `src/index.ts` (after `createApp` returns); tests
   *  prefer driving `reap()` directly so eviction is deterministic. */
  start(): void {
    if (this.reaperHandle !== null) return;
    const handle = setInterval(() => this.reap(), this.reaperIntervalSecs * 1000);
    // unref so the timer doesn't keep the process alive on its own —
    // SIGTERM exits cleanly even if `stop()` is never called.
    handle.unref();
    this.reaperHandle = handle;
  }

  /** Stop the background idle reaper. Idempotent. */
  stop(): void {
    if (this.reaperHandle === null) return;
    clearInterval(this.reaperHandle);
    this.reaperHandle = null;
  }

  /** Walk the cache, evict entries idle past the TTL, then free any
   *  previously-evicted engines whose grace period has elapsed.
   *  Exposed (not private) so tests can drive eviction deterministically
   *  with an injected clock. */
  reap(): void {
    const cutoff = this.now() - this.idleTtlSecs;
    const idleKeys: string[] = [];
    for (const [k, t] of this.lastUsedAt) {
      // Strict `<` matches the "older than" wording of `idleTtlSecs`:
      // an entry used at exactly `cutoff` is at TTL, not past it.
      if (t < cutoff) idleKeys.push(k);
    }
    for (const k of idleKeys) this.evictToPending(k);
    this.drainPendingFree();
  }

  /** Insert into the cache. Single call site for `cache.set` +
   *  `lastUsedAt.set` so the two maps can't drift, and the LRU
   *  eviction trigger lives next to the insertion that triggers it.
   *  Bumps refcount via `acquire` so the caller's returned handle
   *  pins the freshly-built entry against eviction-then-free races. */
  private cacheInsert(k: string, entry: CacheEntry): LoadedEngine {
    this.evictLruIfFull();
    this.cache.set(k, entry);
    this.lastUsedAt.set(k, this.now());
    return this.acquire(entry);
  }

  /** Bump refcount and wrap as a `Disposable` `LoadedEngine`. `Symbol.dispose`
   *  decrements; when refcount hits zero we opportunistically drain
   *  `pendingFree` so an entry whose grace already elapsed gets freed
   *  the moment its last reference goes away. */
  private acquire(entry: CacheEntry): LoadedEngine {
    entry.refcount += 1;
    const release = () => {
      entry.refcount -= 1;
      if (entry.refcount === 0) this.drainPendingFree();
    };
    return {
      get engine() {
        return entry.engine;
      },
      get snapshotVersion() {
        return entry.snapshotVersion;
      },
      [Symbol.dispose]: release,
    };
  }

  /** Evict the least-recently-used entry until the cache is under the
   *  cap. Called from each cache insertion path. Opportunistically
   *  drains `pendingFree` first so a burst of LRU evictions doesn't let
   *  the deferred-free queue accumulate between reaper ticks.
   *
   *  Iterates `cache.keys()` rather than `lastUsedAt` so the loop can
   *  only see authoritative entries — a `lastUsedAt` entry without a
   *  matching `cache` entry (shouldn't happen, but a future code change
   *  could introduce a window) wouldn't make this spin. A `cache`
   *  entry missing its `lastUsedAt` row is treated as oldest. */
  private evictLruIfFull(): void {
    this.drainPendingFree();
    while (this.cache.size >= this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const k of this.cache.keys()) {
        const t = this.lastUsedAt.get(k) ?? -Infinity;
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      this.evictToPending(oldestKey);
    }
  }

  /** Move a cached entry to the pending-free queue without freeing.
   *  An in-flight request may still hold the `LoadedEngine` reference;
   *  `drainPendingFree` calls `free()` only when both the grace
   *  period has elapsed AND refcount is zero. */
  private evictToPending(k: string): void {
    const entry = this.cache.get(k);
    if (!entry) return;
    this.pendingFree.push({ entry, evictedAt: this.now() });
    this.cache.delete(k);
    this.lastUsedAt.delete(k);
  }

  /** Free entries whose grace period has elapsed AND have refcount 0.
   *  Held entries (refcount > 0) stay queued until the last `LoadedEngine`
   *  handle disposes — `acquire`'s dispose calls back here so freeing
   *  happens promptly once the last reference goes. Walks the full
   *  queue (no early-exit) since refcount can stall the head. */
  private drainPendingFree(): void {
    const cutoff = this.now() - PENDING_FREE_GRACE_SECS;
    const kept: typeof this.pendingFree = [];
    for (const item of this.pendingFree) {
      if (item.evictedAt > cutoff || item.entry.refcount > 0) {
        kept.push(item);
      } else {
        item.entry.engine.free();
      }
    }
    this.pendingFree.length = 0;
    this.pendingFree.push(...kept);
  }

  /** Tear everything down. Force-frees every WASM handle regardless of
   *  refcount — only safe when no in-flight request still holds a
   *  `LoadedEngine`. Production never calls this; tests do at end of
   *  each case to drop the WASM heap. */
  clear(): void {
    this.stop();
    for (const entry of this.cache.values()) entry.engine.free();
    this.cache.clear();
    this.lastUsedAt.clear();
    this.tails.clear();
    for (const item of this.pendingFree) item.entry.engine.free();
    this.pendingFree.length = 0;
  }
}
