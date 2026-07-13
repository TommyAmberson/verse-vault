# Schedule Data-Model Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the schedule payload shape from single-passage weeks (`week.passage` +
`week.verses`) to multi-passage weeks (`week.blocks[]`), so subsequent redesign phases (spec §8
phases 3–7) can iterate blocks uniformly and eventually support NT Survey's compound weeks.

**Architecture:** Web and API adopt the v2 shape in-memory and over the wire. Persisted user
schedules and bundled schedule JSONs stay v1-shaped for now; both layers migrate v1→v2 on read and
API downgrades v2→v1 at the WASM engine boundary so the Rust/WASM contract crates need no bump.
Multi-passage schedules (`blocks.length > 1`) are validated as an accepted future shape but rejected
at the WASM boundary until the spec's phase 6 (multi-passage QA) bumps the contract crate.

**Tech Stack:** TypeScript + Vue 3 (`apps/web`), Hono + Drizzle + Vitest (`packages/api`), Rust WASM
engine consumed unchanged.

## Global Constraints

* **Spec:** `docs/superpowers/specs/2026-06-23-schedule-editor-redesign.md` §7 (data model), §8
  (phased plan), §9 (acceptance).
* **Commit format:** Conventional Commits, subject ≤50 chars, imperative mood, lowercase after the
  type/scope prefix. Scopes used here: `api`, `web`. Body wrapped at ~72 cols, explains why.
* **Atomicity:** One logical change per commit. Commit as each task's tests pass — don't batch.
* **Contract crates untouched:** `crates/core` and `crates/wasm` do NOT change in this plan. No
  version bumps there. `tools/check-contract-versions.sh` stays green as long as we don't touch
  `crates/{core,wasm}/src/`.
* **Package version bumps:** `packages/api` is minor-bumped (accepting a new payload shape is
  additive). `apps/web` is minor-bumped (in-memory model change is not user-visible but versioned).
  Each bump must promote its CHANGELOG's `[Unreleased]` to `[X.Y.Z] — YYYY-MM-DD` in the same commit
  — the pre-commit hook enforces this.
* **Backwards compat is real:** Bundled `data/schedules/3-corinthians-2025-26.json` is v1 shape and
  stays v1 through this plan. User schedules already persisted are v1. Both layers must load v1
  without error.
* **`blocks.length` transitional cap:** v2 acceptance in the API validator allows
  `blocks.length ≤ 1` only. `blocks.length > 1` is rejected with a clear message referencing the
  future multi-passage support. The web editor never produces multi-block weeks in this plan.

---

## File Structure

* **`packages/api/src/lib/schedules.ts`** — canonical migration + validator. Exports
  `migrateSchedule(raw)`, `validateSchedule(json)` (returns v2 shape),
  `downgradeScheduleToV1WireFormat(v2)`.
* **`packages/api/src/lib/schedules.test.ts`** (new) — Vitest unit tests for migration + validator.
* **`packages/api/src/lib/engine.ts`** — call `downgradeScheduleToV1WireFormat` before handing
  schedule JSON to `WasmEngine`.
* **`packages/api/src/routes/schedules.ts`** — GET/PUT continue to serve the wire-form JSON; PUT
  accepts either shape (validator normalises).
* **`apps/web/src/lib/schedule.ts`** — v2 types (`PassageBlock`, updated `ScheduleWeek`),
  `migrateSchedule(raw)` mirror of the API's, `cloneSchedule` (unchanged behaviour but retested),
  `verseCountsForWeek` iterates blocks.
* **`apps/web/src/lib/badges.ts`** — one call site reads verses via `blocks[0]?.verses`.
* **`apps/web/src/views/ScheduleEditorView.vue`** — read/write sites (verse inputs, passage form,
  table cells) shim to `blocks[0]`. This is deliberately minimal — the view is fully rewritten in
  the spec's phase 3.
* **`packages/api/CHANGELOG.md`**, **`apps/web/CHANGELOG.md`** — dated `[X.Y.Z]` sections for the
  bumps.

Migration logic is duplicated (~30 lines) across `apps/web/src/lib/schedule.ts` and
`packages/api/src/lib/schedules.ts` because there's no shared TS package. Duplication is small and
the two copies test each other via API round-trips.

---

### Task 1: API — v2 types, migration, validator, unit tests

**Files:**

* Modify: `packages/api/src/lib/schedules.ts`
* Create: `packages/api/src/lib/schedules.test.ts`

**Interfaces:**

* Consumes: nothing new.
* Produces:
  * `interface PassageBlock { passage: ValidatedPassage; verses: ClubVerseLists }`
  * `interface ScheduleWeekV2 { date: string; blocks: PassageBlock[]; isReview: boolean }`
  * `interface SchedulePayloadV2 { version: 2; materialId; season; title; meetingDayOfWeek; weeks: ScheduleWeekV2[]; meets?: ValidatedMeet[] }`
  * `export function migrateSchedule(raw: unknown): SchedulePayloadV2` — throws
    `ScheduleValidationError` on bad shape.
  * `export function validateSchedule(json: string): SchedulePayloadV2` — same signature name as
    today, but return type now v2. Accepts version 1 or 2 in the wire form.
  * `export function downgradeScheduleToV1WireFormat(v2: SchedulePayloadV2): string` — serialises to
    v1-shaped JSON (single-passage weeks). Throws `ScheduleValidationError` when any week has
    `blocks.length > 1`.

* [ ] **Step 1: Write the failing tests**

Create `packages/api/src/lib/schedules.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';

import {
  downgradeScheduleToV1WireFormat,
  migrateSchedule,
  ScheduleValidationError,
  validateSchedule,
} from './schedules.js';

const V1_SCHEDULE = {
  version: 1,
  materialId: '3-corinthians',
  season: '2025-26',
  title: 'Test',
  meetingDayOfWeek: 'Mon',
  weeks: [
    {
      date: '2025-09-08',
      passage: { book: '1 Corinthians', chapter: 1, startVerse: 1, endVerse: 31 },
      verses: { club150: [5, 10], club300: [1, 2] },
      isReview: false,
    },
    {
      date: '2025-11-17',
      passage: null,
      verses: null,
      isReview: true,
    },
  ],
  meets: [],
};

describe('migrateSchedule', () => {
  it('turns a v1 week into a single-block v2 week', () => {
    const out = migrateSchedule(V1_SCHEDULE);
    expect(out.version).toBe(2);
    expect(out.weeks[0]!.blocks).toHaveLength(1);
    expect(out.weeks[0]!.blocks[0]!.passage.book).toBe('1 Corinthians');
    expect(out.weeks[0]!.blocks[0]!.verses.club150).toEqual([5, 10]);
    expect(out.weeks[0]!.isReview).toBe(false);
  });

  it('turns a v1 review week into an empty-blocks v2 week', () => {
    const out = migrateSchedule(V1_SCHEDULE);
    expect(out.weeks[1]!.blocks).toEqual([]);
    expect(out.weeks[1]!.isReview).toBe(true);
  });

  it('is a no-op on a v2 shape', () => {
    const v2 = migrateSchedule(V1_SCHEDULE);
    const again = migrateSchedule(v2);
    expect(again).toEqual(v2);
  });

  it('rejects unknown versions', () => {
    expect(() => migrateSchedule({ ...V1_SCHEDULE, version: 3 })).toThrow(
      ScheduleValidationError,
    );
  });
});

describe('validateSchedule', () => {
  it('accepts v1 wire form and returns v2 shape', () => {
    const out = validateSchedule(JSON.stringify(V1_SCHEDULE));
    expect(out.version).toBe(2);
    expect(out.weeks[0]!.blocks[0]!.passage.chapter).toBe(1);
  });

  it('accepts v2 wire form with a single block', () => {
    const v2 = {
      ...V1_SCHEDULE,
      version: 2,
      weeks: [
        {
          date: '2025-09-08',
          isReview: false,
          blocks: [
            {
              passage: { book: '1 Corinthians', chapter: 1, startVerse: 1, endVerse: 31 },
              verses: { club150: [5], club300: [1] },
            },
          ],
        },
      ],
    };
    const out = validateSchedule(JSON.stringify(v2));
    expect(out.weeks[0]!.blocks[0]!.verses.club150).toEqual([5]);
  });

  it('accepts v2 wire form with two blocks (multi-passage week)', () => {
    const v2 = {
      ...V1_SCHEDULE,
      version: 2,
      weeks: [
        {
          date: '2025-09-08',
          isReview: false,
          blocks: [
            {
              passage: { book: '1 Corinthians', chapter: 1, startVerse: 1, endVerse: 31 },
              verses: { club150: [5], club300: [1] },
            },
            {
              passage: { book: '1 Corinthians', chapter: 2, startVerse: 1, endVerse: 16 },
              verses: { club150: [4], club300: [7] },
            },
          ],
        },
      ],
    };
    const out = validateSchedule(JSON.stringify(v2));
    expect(out.weeks[0]!.blocks).toHaveLength(2);
  });

  it('rejects v2 weeks with malformed blocks', () => {
    const bad = {
      ...V1_SCHEDULE,
      version: 2,
      weeks: [{ date: '2025-09-08', isReview: false, blocks: [{}] }],
    };
    expect(() => validateSchedule(JSON.stringify(bad))).toThrow(ScheduleValidationError);
  });
});

describe('downgradeScheduleToV1WireFormat', () => {
  it('serialises single-block v2 back to v1 shape', () => {
    const v2 = migrateSchedule(V1_SCHEDULE);
    const wire = JSON.parse(downgradeScheduleToV1WireFormat(v2));
    expect(wire.version).toBe(1);
    expect(wire.weeks[0].passage.book).toBe('1 Corinthians');
    expect(wire.weeks[0].verses.club150).toEqual([5, 10]);
    expect(wire.weeks[1].passage).toBeNull();
    expect(wire.weeks[1].verses).toBeNull();
    expect(wire.weeks[1].isReview).toBe(true);
  });

  it('rejects multi-block weeks pending Rust/WASM support', () => {
    const v2 = migrateSchedule({
      ...V1_SCHEDULE,
      version: 2,
      weeks: [
        {
          date: '2025-09-08',
          isReview: false,
          blocks: [
            { passage: V1_SCHEDULE.weeks[0]!.passage, verses: { club150: [], club300: [] } },
            { passage: V1_SCHEDULE.weeks[0]!.passage, verses: { club150: [], club300: [] } },
          ],
        },
      ],
    });
    expect(() => downgradeScheduleToV1WireFormat(v2)).toThrow(ScheduleValidationError);
  });
});
```

* [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @verse-vault/api test -- schedules.test.ts` Expected: FAIL. Symbols
`migrateSchedule`, `downgradeScheduleToV1WireFormat` don't exist yet; `validateSchedule`'s return
type doesn't have `.blocks`.

* [ ] **Step 3: Implement the migration + validator + downgrade**

In `packages/api/src/lib/schedules.ts`, add / replace the following (keep the existing
`loadSchedule`, `loadBundledSchedule`, `ScheduleValidationError`, `isValidIsoDate`,
`requireNonEmptyStr`, `validateMeets`, `ValidatedMeet` unchanged):

```ts
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
    throw new ScheduleValidationError(`weeks[${i}] non-review week must have at least one block`);
  }
  return { date: raw.date, isReview, blocks };
}

/** Normalise a schedule of any accepted wire version to v2 in-memory shape. */
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
 *  currently understands. Rejects multi-block weeks — Rust/WASM support
 *  for multi-passage weeks lands in the redesign's phase 6. */
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
```

Also **delete** the pre-existing `interface SchedulePayload`, `validateWeekPassage`, and the old
body of `validateSchedule` (replaced above). Keep the old `validateSchedule` export **name** so
`routes/schedules.ts` still compiles — the signature `(json: string) => SchedulePayloadV2` is a
breaking change internally but the route only uses the returned object for shape checking, not its
old fields.

* [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @verse-vault/api test -- schedules.test.ts` Expected: PASS. All tests green.

* [ ] **Step 5: Fix compile errors in `routes/schedules.ts`**

`validateSchedule`'s return-type shape changed. Read `packages/api/src/routes/schedules.ts` and
adapt any code that reads `.weeks[i].passage` / `.verses` on the return value to iterate
`.blocks[i]` instead. If the route only uses the returned object as "did it validate?" (throw /
no-throw), no changes needed beyond `pnpm --filter @verse-vault/api type-check` passing.

Run: `pnpm --filter @verse-vault/api type-check` Expected: PASS.

* [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/schedules.ts packages/api/src/lib/schedules.test.ts packages/api/src/routes/schedules.ts
git commit -m "feat(api): accept v2 schedule payloads"
```

Body: explain that the API now normalises v1 or v2 wire form to a single v2 in-memory shape with
`week.blocks[]`; downgrade helper serialises back to v1 for the WASM engine boundary until Rust
catches up.

---

### Task 2: API — downgrade schedule at the WASM boundary

**Files:**

* Modify: `packages/api/src/lib/engine.ts`
* Modify: `packages/api/src/lib/engine.test.ts` (add one test)

**Interfaces:**

* Consumes: `downgradeScheduleToV1WireFormat` from Task 1.

* [ ] **Step 1: Locate the schedule-load site**

Read `packages/api/src/lib/engine.ts` around line 500–580 (the `EngineStore.load` function). Find
where `loadSchedule(db, userId, materialId)` is called and its result passed into `WasmEngine`'s
constructor.

* [ ] **Step 2: Write the failing test**

In `packages/api/src/lib/engine.test.ts`, add a test that:

1. Seeds `material_schedules` with a v2-shaped user schedule (single-block week).
2. Calls `EngineStore.load` (or equivalent public entry point).
3. Asserts the WASM engine constructed successfully — i.e., the load path downgraded the persisted
   v2 to v1 before handing it to Rust.

If `engine.test.ts` doesn't already have a schedule-round-trip case, base the new test on an
existing "loads bundled schedule" case, and swap in a manually-persisted v2 row.

* [ ] **Step 3: Run the test to see it fail**

Run: `pnpm --filter @verse-vault/api test -- engine.test.ts` Expected: FAIL — WASM parse errors on
`blocks[]` field.

* [ ] **Step 4: Wire the downgrade**

In `EngineStore.load`, change:

```ts
const scheduleJson = loadSchedule(db, userId, materialId);
```

to:

```ts
const rawScheduleJson = loadSchedule(db, userId, materialId);
const scheduleJson = rawScheduleJson === ''
  ? ''
  : downgradeScheduleToV1WireFormat(migrateSchedule(JSON.parse(rawScheduleJson)));
```

Import `downgradeScheduleToV1WireFormat` and `migrateSchedule` at the top of the file.

* [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @verse-vault/api test` Expected: PASS.

* [ ] **Step 6: Commit**

```bash
git add packages/api/src/lib/engine.ts packages/api/src/lib/engine.test.ts
git commit -m "feat(api): downgrade schedule to v1 for WASM"
```

Body: explain that persisted / bundled schedules are normalised to v2 in memory, then serialised
back to v1 wire form on the way into the WASM engine — the Rust contract crates aren't updated in
this train.

---

### Task 3: Web — schedule.ts v2 types + migration + `verseCountsForWeek`

**Files:**

* Modify: `apps/web/src/lib/schedule.ts`

**Interfaces:**

* Produces:
  * `interface PassageBlock { passage: SchedulePassage; verses: ScheduleVerses }`
  * `interface ScheduleWeek { date: string; blocks: PassageBlock[]; isReview: boolean }` (replaces
    the current `passage` / `verses` fields)
  * `Schedule.version: 2`
  * `export function migrateSchedule(raw: unknown): Schedule`
  * `verseCountsForWeek(week: ScheduleWeek): { club150: number; club300: number }` (sums across all
    blocks)

* [ ] **Step 1: Update the types**

In `apps/web/src/lib/schedule.ts`:

Replace `ScheduleWeek`'s shape:

```ts
export interface PassageBlock {
  passage: SchedulePassage
  verses: ScheduleVerses
}

export interface ScheduleWeek {
  date: string
  /** Empty on review weeks. Length ≥1 on normal weeks. Multi-passage
   *  weeks (length ≥2) are aspirational — the API rejects them at
   *  save time until the WASM engine supports them (spec phase 6). */
  blocks: PassageBlock[]
  isReview: boolean
}
```

Change `Schedule.version: 1` to `Schedule.version: 2`.

* [ ] **Step 2: Add the migration function**

Add `migrateSchedule` under a new "Migration" section:

```ts
// =============================================================================
// Migration (v1 → v2)
// =============================================================================

/** Normalise a schedule of any accepted wire version to the v2 in-memory
 *  shape. Mirrors `packages/api/src/lib/schedules.ts:migrateSchedule` —
 *  the API also runs this so persisted user schedules and bundled JSONs
 *  land in the same shape everywhere. */
export function migrateSchedule(raw: unknown): Schedule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('schedule must be an object')
  }
  const obj = raw as Record<string, unknown>
  const version = obj.version
  if (version !== 1 && version !== 2) {
    throw new Error(`unsupported schedule version: ${String(version)}`)
  }
  const weeksRaw = obj.weeks
  if (!Array.isArray(weeksRaw)) throw new Error('missing weeks array')
  const weeks: ScheduleWeek[] = weeksRaw.map((w) => {
    const wo = w as Record<string, unknown>
    const isReview = wo.isReview === true
    if (version === 2) {
      const blocks = (wo.blocks as PassageBlock[] | undefined) ?? []
      return { date: wo.date as string, isReview, blocks }
    }
    if (isReview) {
      return { date: wo.date as string, isReview: true, blocks: [] }
    }
    const passage = wo.passage as SchedulePassage
    const verses = (wo.verses as ScheduleVerses | null | undefined) ?? {}
    return {
      date: wo.date as string,
      isReview: false,
      blocks: [{ passage, verses }],
    }
  })
  return {
    version: 2,
    materialId: obj.materialId as string,
    season: obj.season as string,
    title: obj.title as string,
    meetingDayOfWeek: obj.meetingDayOfWeek as DayOfWeek,
    weeks,
    meets: (obj.meets as ScheduleMeet[] | undefined) ?? [],
  }
}
```

* [ ] **Step 3: Update `verseCountsForWeek` to iterate blocks**

Replace:

```ts
export function verseCountsForWeek(week: ScheduleWeek): { club150: number; club300: number } {
  return {
    club150: week.verses?.club150?.length ?? 0,
    club300: week.verses?.club300?.length ?? 0,
  }
}
```

With:

```ts
export function verseCountsForWeek(week: ScheduleWeek): { club150: number; club300: number } {
  let c150 = 0
  let c300 = 0
  for (const b of week.blocks) {
    c150 += b.verses.club150?.length ?? 0
    c300 += b.verses.club300?.length ?? 0
  }
  return { club150: c150, club300: c300 }
}
```

* [ ] **Step 4: Verify `cloneSchedule` still reactive-safe**

`cloneSchedule` uses `JSON.parse(JSON.stringify(s))`, which handles nested `blocks` arrays
uniformly. No change required. Update the docstring's last sentence from "`Schedule` carries only
string / number / boolean / null / array / object" — this is still true after the shape change; the
docstring's core claim holds.

* [ ] **Step 5: Type-check (expected to fail — consumers still read `week.passage`)**

Run: `pnpm --filter @verse-vault/web type-check` Expected: FAIL with errors in `badges.ts` and
`ScheduleEditorView.vue` — those are fixed in Task 4.

Do **not** commit until Task 4 lands (types touch consumers that Task 4 fixes; commit as one logical
change).

---

### Task 4: Web — badges.ts + ScheduleEditorView.vue minimal consumer migration

**Files:**

* Modify: `apps/web/src/lib/badges.ts`
* Modify: `apps/web/src/views/ScheduleEditorView.vue`

**Interfaces:**

* Consumes: `PassageBlock`, updated `ScheduleWeek` from Task 3.

* [ ] **Step 1: Update `badges.ts:83`**

Read `apps/web/src/lib/badges.ts` around line 74–90. Replace:

```ts
const w = weeks[i]?.verses
if (!w) continue
for (const club of enabledClubs) {
  sum += w[club]?.length ?? 0
}
```

with:

```ts
const week = weeks[i]
if (!week) continue
for (const block of week.blocks) {
  for (const club of enabledClubs) {
    sum += block.verses[club]?.length ?? 0
  }
}
```

* [ ] **Step 2: Update `ScheduleEditorView.vue` consumers**

Read `apps/web/src/views/ScheduleEditorView.vue` around the sites returned by the earlier grep —
approximate line numbers:

* L198–199 (`verseInput150.value = formatVerseList(w?.verses?.club150)`) — read
  `w?.blocks[0]?.verses.club150`.
* L217 (`const nextVerses = { ...(week.verses ?? {}), [tier]: parsed }`) — rewrite as building a new
  `blocks[0]` with updated verses, keeping other blocks (if any) untouched.
* L236 (`if (week.passage === null) return`) — replace with `if (week.blocks.length === 0) return`.
* L239 (`passage: { ...week.passage, [key]: value }`) — mutate `blocks[0].passage`.
* L262–263 — read from `blocks[0]?.verses`.
* L640 (`formatPassage(row.week.passage)`) — pass `row.week.blocks[0]?.passage ?? null`.
* L642–648 (verse-list spans) — iterate `row.week.blocks[0]?.verses`.
* L707 (`v-if="!selectedWeek.isReview && selectedWeek.passage"`) — replace with
  `!selectedWeek.isReview && selectedWeek.blocks[0]`.
* L714, L723, L732, L741 (`selectedWeek.passage.book` etc.) — read from
  `selectedWeek.blocks[0].passage`.

These edits are deliberately minimal: they preserve current behaviour for single-passage weeks. The
full view rewrite happens in the redesign's phase 3.

Where a helper `firstBlock(week: ScheduleWeek): PassageBlock | undefined` would clean up repeated
`week.blocks[0]` access, add it near the other display helpers in `schedule.ts` and use it. Keep the
change small — one helper max.

* [ ] **Step 3: Verify type-check + web builds**

Run: `pnpm --filter @verse-vault/web type-check` Expected: PASS.

Run: `pnpm --filter @verse-vault/web build` Expected: PASS.

* [ ] **Step 4: Manually smoke-test the view**

Start the app: `pnpm dev:all`, log in as a profile with an enrolled deck, visit
`/schedule/nkjv-cor`. Verify:

* The current (printable) table renders passage + verse cells for each week.
* Editing a week's passage / verse list still saves (`PUT /api/materials/nkjv-cor/schedule` returns
  200 in dev tools).
* Reload after save: values persist.

If any regressions surface that aren't in the file:line list above, fix them here — don't defer.

* [ ] **Step 5: Commit**

Task 3 + Task 4 land together:

```bash
git add apps/web/src/lib/schedule.ts apps/web/src/lib/badges.ts apps/web/src/views/ScheduleEditorView.vue
git commit -m "feat(web): switch schedule model to blocks"
```

Body: explain that `ScheduleWeek` now carries `blocks: PassageBlock[]` (empty on review, 1 on normal
weeks). Consumers read `blocks[0]` for now — the view rewrite in phase 3 uses the full array.
`migrateSchedule` handles v1 payloads returned by the API today.

---

### Task 5: Web — bump version + CHANGELOG

**Files:**

* Modify: `apps/web/package.json`
* Modify: `apps/web/CHANGELOG.md`

* [ ] **Step 1: Read current CHANGELOG state**

Read `apps/web/CHANGELOG.md` — confirm there's an `## [Unreleased]` section describing this
migration. If empty, add:

```
## [Unreleased]

### Changed
- Schedule data model: `Week.passage` / `Week.verses` collapsed into
  `Week.blocks: PassageBlock[]`. `migrateSchedule` normalises v1 payloads
  the API still emits so persisted schedules load transparently.
```

* [ ] **Step 2: Bump `apps/web/package.json`**

Change `"version": "0.4.0"` to `"version": "0.5.0"`.

* [ ] **Step 3: Promote `[Unreleased]` in the CHANGELOG**

Rename the `## [Unreleased]` section to `## [0.5.0] — 2026-07-11` and leave a fresh empty
`## [Unreleased]` above it.

* [ ] **Step 4: Verify pre-commit gate would pass**

Run: `tools/check-contract-versions.sh` Expected: exits 0 (no error; version-bump commit and
CHANGELOG section are consistent).

* [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/CHANGELOG.md
git commit -m "chore(web): release 0.5.0"
```

Body: reference the schedule-model migration.

---

### Task 6: API — bump version + CHANGELOG

**Files:**

* Modify: `packages/api/package.json`
* Modify: `packages/api/CHANGELOG.md`

* [ ] **Step 1: Bump `packages/api/package.json`**

Change `"version": "0.1.29"` to `"version": "0.1.30"`.

* [ ] **Step 2: Promote `[Unreleased]` in the CHANGELOG**

Read `packages/api/CHANGELOG.md`. If there is no `## [Unreleased]` section (or it's stale), add one
first with:

```
### Changed
- `/api/materials/:id/schedule` now accepts either v1 or v2 payload
  shapes; internally normalised to v2 (`week.blocks[]`). Multi-passage
  weeks (`blocks.length > 1`) are validated but rejected at the WASM
  engine boundary until Rust support lands.
```

Then rename the `## [Unreleased]` section to `## [0.1.30] — 2026-07-11`. Under
`### Bundled algorithm contract`, keep the current `verse-vault-core` and `verse-vault-wasm`
versions — this release does NOT bump them.

* [ ] **Step 3: Verify pre-commit gate would pass**

Run: `tools/check-contract-versions.sh` Expected: exits 0.

* [ ] **Step 4: Commit**

```bash
git add packages/api/package.json packages/api/CHANGELOG.md
git commit -m "chore(api): release 0.1.30"
```

---

### Task 7: Verification pass

**Files:** none (verification only).

* [ ] **Step 1: Full test suite**

Run: `pnpm test` Expected: PASS across all workspaces.

* [ ] **Step 2: Full type-check**

Run: `pnpm type-check` Expected: PASS.

* [ ] **Step 3: Contract-crate check**

Run: `tools/check-contract-versions.sh` Expected: exits 0. Confirms we did not touch
`crates/{core,wasm}/src/` and both consumer bumps have matching dated CHANGELOG sections.

* [ ] **Step 4: Manual API round-trip smoke**

Start the API dev server (`pnpm dev:api`). Using an authenticated session cookie (or a curl session
cloned from the browser):

* `GET /api/materials/nkjv-cor/schedule` — expect 200 + v2 body with `weeks[i].blocks[0].passage`.
* `PUT /api/materials/nkjv-cor/schedule` with a v1-shape body (as a browser tab today would send
  after a save) — expect 200. Follow-up GET returns v2 normalised.
* `PUT` with a v2-shape single-block body — expect 200.
* `PUT` with a v2-shape two-block body — expect 400 with the "multi-passage weeks not yet supported"
  message (thrown by `downgradeScheduleToV1WireFormat` when the engine tries to load, OR earlier —
  either surface is acceptable as long as it's a 4xx / not a 500).
* `GET /api/cards/memorize/session?materialId=nkjv-cor&max=1` — expect 200 with a card, confirming
  the WASM engine loaded successfully after downgrade.

* [ ] **Step 5: Manual web smoke**

Refresh the web app, visit `/schedule/nkjv-cor`:

* The printable table renders.
* Edit a week's verse list; save. Reload; the change persists.
* Edit a week's passage. Reload; persists.

* [ ] **Step 6: Push**

```bash
git push
```

The remote branch already has the earlier revert / spec commits — this train stacks on top. Do not
open a PR yet; PR #102 is in draft and phase 3 (view rewrite) continues on this branch.

---

## Self-Review

**Spec coverage:**

* §7.2 — recommended shape adopted (blocks). ✓
* §7.3 — `migrateSchedule` implemented on both web and API. ✓
* §7.5 — `cloneSchedule` reactive-safe with nested blocks (JSON round-trip); web and API consumers
  migrated. ✓
* §8.2 — "Data model — update `Week` type + `PassageBlock`, write `migrateWeek`/`migrateSchedule`,
  bump `version`, update `cloneSchedule`, update `packages/api` validation. Land with unit tests on
  migration." — all covered; unit tests live in `packages/api/src/lib/schedules.test.ts` because web
  has no test runner (documented in the plan preamble). ✓
* §9 acceptance criteria — the migration-specific ones (`version` bumped, old persisted schedules
  load, `cloneSchedule` reactive-safe with nested blocks) are covered here. Layout / responsive /
  multi-passage acceptance criteria are phases 3+ and out of scope.

**Placeholder scan:** none.

**Type consistency:** `PassageBlock` fields (`passage`, `verses`) match between the API and web
declarations. `verseCountsForWeek` and `firstBlock` helper referenced only in Task 3/4 where they
are defined.
