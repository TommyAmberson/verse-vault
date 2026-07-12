import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';

import * as schema from '../db/schema.js';
import type { DB } from '../db/client.js';

/**
 * Per-(deck, season) memorize schedule loader.
 *
 * Schedules ship as `data/schedules/<deck>-<season>.json` (e.g.
 * `3-corinthians-2025-26.json`). The user's customised copy lives in
 * `material_schedules` and overrides the bundled default. The TS layer
 * doesn't inspect the body — it's passed verbatim to the WASM engine.
 *
 * Returning `''` for a material with no bundled schedule and no user
 * row is intentional: the WASM constructor accepts empty `schedule_json`
 * and the memorize algorithm collapses to pure-Sequential, which matches
 * the pre-Phase-1 behaviour exactly for decks that haven't shipped a
 * schedule yet.
 */

/** Candidate directories where bundled schedule files might live.
 *  Searched in order — bundle-local first because that's the production
 *  layout, repo-root second so dev keeps working without a build step.
 *  Mirrors `materials.ts`'s `DECK_DIRS` resolution. */
const SCHEDULE_DIRS: readonly string[] = [
  resolve(import.meta.dirname, '../..', 'data', 'schedules'),
  resolve(import.meta.dirname, '../../../..', 'data', 'schedules'),
];

/** materialId → deck filename base. Mirrors the mapping in
 *  `materials.ts:DATA_FILES`, minus the `.json` suffix. Schedules are
 *  named `<base>-<season>.json` so the prefix lookup below picks them
 *  up from disk. */
const SCHEDULE_FILE_PREFIXES: Record<string, string> = {
  'nkjv-gepc': '1-gepc',
  'nkjv-nt': '2-nt-survey',
  'nkjv-cor': '3-corinthians',
  'nkjv-john': '4-john',
  'nkjv-hp': '5-hp',
  'nkjv-ot': '6-ot-survey',
  'nkjv-rj': '7-rj',
  'nkjv-luke': '8-luke',
};

interface CachedEntry {
  mtime: number;
  json: string;
}

const cache = new Map<string, CachedEntry>();

/** Bundled-default schedule JSON for a material. Returns `''` when no
 *  schedule ships for this material. The result is cached in process
 *  keyed by file mtime so dev edits pick up automatically.
 *
 *  When multiple `<prefix>-<season>.json` files exist, picks the one
 *  with the highest filename (lexical sort puts later seasons last —
 *  `3-corinthians-2026-27.json > 3-corinthians-2025-26.json`). Future
 *  improvement: pick by today's date falling within the season's
 *  week range; for v1 the lexical pick matches the active season as
 *  long as the file naming is monotonic. */
export function loadBundledSchedule(materialId: string): string {
  const prefix = SCHEDULE_FILE_PREFIXES[materialId];
  if (prefix === undefined) return '';

  for (const dir of SCHEDULE_DIRS) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir);
    const matches = files
      .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.json'))
      .sort();
    if (matches.length === 0) continue;
    const filename = matches[matches.length - 1]!;
    const full = resolve(dir, filename);
    const stat = statSync(full);
    const mtime = Number(stat.mtimeMs);
    const key = full;
    const cached = cache.get(key);
    if (cached !== undefined && cached.mtime === mtime) {
      return cached.json;
    }
    const json = readFileSync(full, 'utf8');
    cache.set(key, { mtime, json });
    return json;
  }
  return '';
}

/** Per-user schedule JSON for a material. Returns the user's customised
 *  copy when present, otherwise falls back to the bundled default.
 *  Returns `''` when neither exists; the WASM engine handles the empty
 *  case (pure-Sequential memorize algorithm). */
export function loadSchedule(db: DB, userId: string, materialId: string): string {
  const row = db
    .select({ scheduleJson: schema.materialSchedules.scheduleJson })
    .from(schema.materialSchedules)
    .where(
      and(
        eq(schema.materialSchedules.userId, userId),
        eq(schema.materialSchedules.materialId, materialId),
      ),
    )
    .get();
  if (row !== undefined) return row.scheduleJson;
  return loadBundledSchedule(materialId);
}

/** Shape-check a candidate schedule JSON string. Returns the parsed
 *  object on success; throws a `ScheduleValidationError` (subclass of
 *  Error) with a one-line message on the first violation.
 *
 *  Only structural fields are checked here — the WASM `parse_schedule`
 *  call applies a stricter validation via `serde::Deserialize` when the
 *  engine is constructed. This validator is for the PUT route's
 *  fast-fail path so bad payloads don't reach disk. */
export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleValidationError';
  }
}

/** `YYYY-MM-DD` with sane month/day ranges (1-12 / 1-31). The Rust-side
 *  `parse_iso_date` rejects 0-month / 0-day, so accepting them at the API
 *  boundary would silently disable schedule logic for that week (and via
 *  `current_week_index`'s defensive skip, lose the week from cumulative
 *  counts). Catch them here so the user sees a 400 instead. */
function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** Spec'd Meet shape from data/schedules/*.json. `id` is a stable slug
 *  the chain UI's `move_to_next` gates may reference; `startDate` and
 *  `endDate` define the major-checkpoint window for those gates. The
 *  Phase 3 editor writes user customisations to this surface, so the
 *  server has to defend the shape.
 *
 *  `location` is intentionally an arbitrary string and may be empty —
 *  the bundled schedules already use "TBD" as a placeholder for the
 *  Second Weekend Meet, and the editor lets users clear the field. */
export interface ValidatedMeet {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  location: string;
}

interface ValidatedPassage {
  book: string;
  chapter: number;
  startVerse: number;
  endVerse: number;
}

interface ClubVerseLists {
  club150: number[];
  club300: number[];
}

/** One passage's worth of a week's content: a `(book, chapter,
 *  start..end)` reference and the per-club verse-number splits within
 *  that reference. Normal weeks carry one block; NT Survey-style
 *  compound weeks carry two. The multi-passage case is defined by
 *  the redesign spec (`docs/superpowers/specs/2026-06-23-schedule-editor-redesign.md`)
 *  and accepted at validation time — but the WASM engine still expects
 *  the v1 single-passage shape, so `downgradeScheduleToV1WireFormat`
 *  refuses `blocks.length > 1` until Rust support lands. */
export interface PassageBlock {
  passage: ValidatedPassage;
  verses: ClubVerseLists;
}

export interface ScheduleWeekV2 {
  date: string;
  blocks: PassageBlock[];
  isReview: boolean;
}

export interface SchedulePayloadV2 {
  version: 2;
  materialId: string;
  season: string;
  title: string;
  meetingDayOfWeek: string;
  weeks: ScheduleWeekV2[];
  meets?: ValidatedMeet[];
}

function validatePassage(label: string, raw: unknown): ValidatedPassage {
  if (typeof raw !== 'object' || raw === null) {
    throw new ScheduleValidationError(`${label} must be an object`);
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.book !== 'string' || p.book.length === 0) {
    throw new ScheduleValidationError(`${label}.book must be a non-empty string`);
  }
  for (const f of ['chapter', 'startVerse', 'endVerse'] as const) {
    const v = p[f];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new ScheduleValidationError(`${label}.${f} must be a positive integer`);
    }
  }
  if ((p.endVerse as number) < (p.startVerse as number)) {
    throw new ScheduleValidationError(`${label}.endVerse is before startVerse`);
  }
  return {
    book: p.book,
    chapter: p.chapter as number,
    startVerse: p.startVerse as number,
    endVerse: p.endVerse as number,
  };
}

function validateClubVerseLists(label: string, raw: unknown): ClubVerseLists {
  if (raw === undefined || raw === null) return { club150: [], club300: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScheduleValidationError(`${label} must be an object`);
  }
  const v = raw as Record<string, unknown>;
  const arr = (key: 'club150' | 'club300'): number[] => {
    const val = v[key];
    if (val === undefined) return [];
    if (!Array.isArray(val)) {
      throw new ScheduleValidationError(`${label}.${key} must be an array`);
    }
    for (const n of val) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
        throw new ScheduleValidationError(`${label}.${key} entries must be positive integers`);
      }
    }
    return val as number[];
  };
  return { club150: arr('club150'), club300: arr('club300') };
}

function validateBlock(label: string, raw: unknown): PassageBlock {
  if (typeof raw !== 'object' || raw === null) {
    throw new ScheduleValidationError(`${label} must be an object`);
  }
  const b = raw as Record<string, unknown>;
  return {
    passage: validatePassage(`${label}.passage`, b.passage),
    verses: validateClubVerseLists(`${label}.verses`, b.verses),
  };
}

function migrateV1Week(i: number, raw: Record<string, unknown>): ScheduleWeekV2 {
  if (typeof raw.date !== 'string' || !isValidIsoDate(raw.date)) {
    throw new ScheduleValidationError(`weeks[${i}].date must be a real YYYY-MM-DD`);
  }
  const isReview = raw.isReview === true;
  if (isReview) {
    return { date: raw.date, isReview: true, blocks: [] };
  }
  return {
    date: raw.date,
    isReview: false,
    blocks: [
      {
        passage: validatePassage(`weeks[${i}].passage`, raw.passage),
        verses: validateClubVerseLists(`weeks[${i}].verses`, raw.verses),
      },
    ],
  };
}

function validateV2Week(i: number, raw: Record<string, unknown>): ScheduleWeekV2 {
  if (typeof raw.date !== 'string' || !isValidIsoDate(raw.date)) {
    throw new ScheduleValidationError(`weeks[${i}].date must be a real YYYY-MM-DD`);
  }
  const isReview = raw.isReview === true;
  const blocksRaw = raw.blocks;
  if (!Array.isArray(blocksRaw)) {
    throw new ScheduleValidationError(`weeks[${i}].blocks must be an array`);
  }
  const blocks = blocksRaw.map((b, j) => validateBlock(`weeks[${i}].blocks[${j}]`, b));
  if (!isReview && blocks.length === 0) {
    throw new ScheduleValidationError(
      `weeks[${i}] non-review week must have at least one block`,
    );
  }
  return { date: raw.date, isReview, blocks };
}

/** Pull a non-empty string field off a record. Shared by the top-level
 *  schedule fields and the per-meet field-checks — both error formats
 *  differ only in the prefix, so the caller passes a lazy label
 *  builder rather than two near-identical closures inside the same
 *  file. */
function requireNonEmptyStr(
  src: Record<string, unknown>,
  k: string,
  label: () => string,
): string {
  const v = src[k];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ScheduleValidationError(label());
  }
  return v;
}

/** Normalise a schedule payload of either accepted wire version (1 or 2)
 *  to the v2 in-memory shape (`week.blocks[]`). Throws
 *  `ScheduleValidationError` on any structural violation.
 *
 *  This is the single source of truth for schedule shape at the API
 *  boundary — `validateSchedule` (raw JSON) and `EngineStore.load`
 *  (persisted DB rows / bundled JSON files) both call this to converge
 *  on v2 before further processing. */
export function migrateSchedule(raw: unknown): SchedulePayloadV2 {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ScheduleValidationError('schedule must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.version;
  if (version !== 1 && version !== 2) {
    throw new ScheduleValidationError(`unsupported schedule version: ${String(version)}`);
  }
  const requireStr = (k: string): string =>
    requireNonEmptyStr(obj, k, () => `missing string field: ${k}`);
  const materialId = requireStr('materialId');
  const season = requireStr('season');
  const title = requireStr('title');
  const meetingDayOfWeek = requireStr('meetingDayOfWeek');
  const weeksRaw = obj.weeks;
  if (!Array.isArray(weeksRaw)) {
    throw new ScheduleValidationError('missing array field: weeks');
  }
  const weeks: ScheduleWeekV2[] = weeksRaw.map((w, i) => {
    if (typeof w !== 'object' || w === null) {
      throw new ScheduleValidationError(`weeks[${i}] must be an object`);
    }
    const wo = w as Record<string, unknown>;
    return version === 1 ? migrateV1Week(i, wo) : validateV2Week(i, wo);
  });
  const meets = validateMeets(obj.meets);
  return {
    version: 2,
    materialId,
    season,
    title,
    meetingDayOfWeek,
    weeks,
    meets,
  };
}

export function validateSchedule(json: string): SchedulePayloadV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ScheduleValidationError(`invalid JSON: ${(e as Error).message}`);
  }
  return migrateSchedule(parsed);
}

/** Serialise a v2 schedule back to the v1 wire shape the WASM engine
 *  understands today (`{ passage, verses } | { passage: null, verses:
 *  null, isReview: true }`). Rejects multi-block weeks — Rust/WASM
 *  support for compound weeks lands in the redesign's phase 6. */
export function downgradeScheduleToV1WireFormat(v2: SchedulePayloadV2): string {
  const weeks = v2.weeks.map((w, i) => {
    if (w.blocks.length > 1) {
      throw new ScheduleValidationError(
        `weeks[${i}] has ${w.blocks.length} blocks; multi-passage weeks are not yet supported by the WASM engine`,
      );
    }
    const block = w.blocks[0];
    return {
      date: w.date,
      isReview: w.isReview,
      passage: block ? block.passage : null,
      verses: block ? block.verses : null,
    };
  });
  return JSON.stringify({
    version: 1,
    materialId: v2.materialId,
    season: v2.season,
    title: v2.title,
    meetingDayOfWeek: v2.meetingDayOfWeek,
    weeks,
    meets: v2.meets ?? [],
  });
}

/** Field-level validation for the `meets` array. The Phase 3 editor
 *  writes user customisations through this surface, so each meet has to
 *  be defended — a malformed `startDate` would silently disable the
 *  `afterMajorCheckpoint` gate's "most recent past meet" lookup, and
 *  duplicate `id`s would make stable referencing impossible. */
function validateMeets(raw: unknown): ValidatedMeet[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ScheduleValidationError('meets must be an array when present');
  }
  const seenIds = new Set<string>();
  const meets: ValidatedMeet[] = [];
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    if (typeof m !== 'object' || m === null) {
      throw new ScheduleValidationError(`meets[${i}] must be an object`);
    }
    const mo = m as Record<string, unknown>;
    const requireMeetStr = (k: string): string =>
      requireNonEmptyStr(
        mo,
        k,
        () => `meets[${i}].${k} must be a non-empty string`,
      );
    const id = requireMeetStr('id');
    if (seenIds.has(id)) {
      throw new ScheduleValidationError(`meets[${i}].id "${id}" is duplicated`);
    }
    seenIds.add(id);
    const name = requireMeetStr('name');
    const startDate = requireMeetStr('startDate');
    if (!isValidIsoDate(startDate)) {
      throw new ScheduleValidationError(`meets[${i}].startDate must be a real YYYY-MM-DD`);
    }
    const endDate = requireMeetStr('endDate');
    if (!isValidIsoDate(endDate)) {
      throw new ScheduleValidationError(`meets[${i}].endDate must be a real YYYY-MM-DD`);
    }
    if (endDate < startDate) {
      throw new ScheduleValidationError(`meets[${i}].endDate is before startDate`);
    }
    // `location` accepts any string including '' — the bundled schedules
    // ship "TBD" as a placeholder, and the editor exposes the field as
    // freely clearable. Missing field falls through to ''.
    const locRaw = mo.location;
    if (locRaw !== undefined && typeof locRaw !== 'string') {
      throw new ScheduleValidationError(`meets[${i}].location must be a string`);
    }
    const location = locRaw ?? '';
    meets.push({ id, name, startDate, endDate, location });
  }
  return meets;
}
