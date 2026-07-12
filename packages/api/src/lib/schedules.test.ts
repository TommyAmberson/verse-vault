import { describe, expect, it } from 'vitest';

import { createTestDb, createTestUser } from '../test-utils.js';
import * as schema from '../db/schema.js';
import {
  downgradeScheduleToV1WireFormat,
  migrateSchedule,
  ScheduleValidationError,
  loadBundledSchedule,
  loadSchedule,
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

describe('loadBundledSchedule', () => {
  it('returns the shipped 3-corinthians-2025-26 schedule for nkjv-cor', () => {
    const json = loadBundledSchedule('nkjv-cor');
    expect(json).not.toBe('');
    const parsed = JSON.parse(json);
    expect(parsed.materialId).toBe('nkjv-cor');
    expect(parsed.season).toBe('2025-26');
    expect(parsed.weeks.length).toBeGreaterThan(0);
    expect(parsed.meets.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty string when no schedule ships for the material', () => {
    // Decks beyond 3-corinthians have no bundled schedule in Phase 1.
    expect(loadBundledSchedule('nkjv-john')).toBe('');
  });

  it('returns empty string for an unknown material id', () => {
    expect(loadBundledSchedule('nope')).toBe('');
  });
});

describe('loadSchedule', () => {
  it('falls back to bundled when no user row exists', () => {
    const test = createTestDb();
    try {
      createTestUser(test.db, 'u1');
      const json = loadSchedule(test.db, 'u1', 'nkjv-cor');
      expect(JSON.parse(json).materialId).toBe('nkjv-cor');
    } finally {
      test.cleanup();
    }
  });

  it('returns the user copy when present, overriding the bundled default', () => {
    const test = createTestDb();
    try {
      createTestUser(test.db, 'u1');
      const custom = JSON.stringify({
        version: 1,
        materialId: 'nkjv-cor',
        season: '2025-26',
        title: 'Custom',
        meetingDayOfWeek: 'Tue',
        weeks: [],
        meets: [],
      });
      test.db
        .insert(schema.materialSchedules)
        .values({
          userId: 'u1',
          materialId: 'nkjv-cor',
          scheduleJson: custom,
          updatedAt: 1_700_000_000,
        })
        .run();
      const json = loadSchedule(test.db, 'u1', 'nkjv-cor');
      expect(JSON.parse(json).title).toBe('Custom');
    } finally {
      test.cleanup();
    }
  });

  it('returns empty for an enrolled material with no bundled and no user copy', () => {
    const test = createTestDb();
    try {
      createTestUser(test.db, 'u1');
      expect(loadSchedule(test.db, 'u1', 'nkjv-john')).toBe('');
    } finally {
      test.cleanup();
    }
  });
});

describe('validateSchedule', () => {
  it('accepts a well-formed payload', () => {
    const json = loadBundledSchedule('nkjv-cor');
    expect(() => validateSchedule(json)).not.toThrow();
  });

  it('rejects malformed JSON', () => {
    expect(() => validateSchedule('not json')).toThrow(ScheduleValidationError);
  });

  it('rejects non-object roots', () => {
    expect(() => validateSchedule('[]')).toThrow(/object/);
    expect(() => validateSchedule('null')).toThrow(/object/);
    expect(() => validateSchedule('"a"')).toThrow(/object/);
  });

  it('rejects unsupported version', () => {
    const bad = JSON.stringify({
      version: 99,
      materialId: 'x',
      season: 'y',
      title: 't',
      meetingDayOfWeek: 'Mon',
      weeks: [],
    });
    expect(() => validateSchedule(bad)).toThrow(/version/);
  });

  it('rejects missing required string fields', () => {
    const bad = JSON.stringify({
      version: 1,
      season: 'y',
      title: 't',
      meetingDayOfWeek: 'Mon',
      weeks: [],
    });
    expect(() => validateSchedule(bad)).toThrow(/materialId/);
  });

  it('rejects week with bad date format', () => {
    const bad = JSON.stringify({
      version: 1,
      materialId: 'x',
      season: 'y',
      title: 't',
      meetingDayOfWeek: 'Mon',
      weeks: [{ date: '09/08/2025', isReview: false }],
    });
    expect(() => validateSchedule(bad)).toThrow(/date/);
  });

  it('rejects month=00 / day=00 dates that the Rust parser would also reject', () => {
    // The regex on its own accepts these; isValidIsoDate catches them.
    // current_week_index defensively skips bad rows now, but the API
    // shouldn't let them through in the first place.
    for (const date of ['2025-00-08', '2025-13-08', '2025-09-00', '2025-09-32']) {
      const bad = JSON.stringify({
        version: 1,
        materialId: 'x',
        season: 'y',
        title: 't',
        meetingDayOfWeek: 'Mon',
        weeks: [{ date, isReview: false }],
      });
      expect(() => validateSchedule(bad)).toThrow(/date/);
    }
  });

  it('rejects non-array meets', () => {
    const bad = JSON.stringify({
      version: 1,
      materialId: 'x',
      season: 'y',
      title: 't',
      meetingDayOfWeek: 'Mon',
      weeks: [],
      meets: 'nope',
    });
    expect(() => validateSchedule(bad)).toThrow(/meets/);
  });

  it('accepts a well-formed meets array', () => {
    const ok = JSON.stringify({
      version: 1,
      materialId: 'x',
      season: 'y',
      title: 't',
      meetingDayOfWeek: 'Mon',
      weeks: [],
      meets: [
        {
          id: 'first',
          name: 'First Quiz Meet',
          startDate: '2026-01-10',
          endDate: '2026-01-12',
          location: 'Heritage Alliance Church',
        },
      ],
    });
    const parsed = validateSchedule(ok);
    expect(parsed.meets).toHaveLength(1);
    expect(parsed.meets?.[0].id).toBe('first');
  });

  it('rejects meets with missing or malformed fields', () => {
    const base = {
      version: 1,
      materialId: 'x',
      season: 'y',
      title: 't',
      meetingDayOfWeek: 'Mon',
      weeks: [],
    };
    const validMeet = {
      id: 'first',
      name: 'First',
      startDate: '2026-01-10',
      endDate: '2026-01-12',
      location: 'X',
    };
    // Missing each required field in turn.
    for (const k of ['id', 'name', 'startDate', 'endDate'] as const) {
      const { [k]: _omit, ...partial } = validMeet;
      const bad = JSON.stringify({ ...base, meets: [partial] });
      expect(() => validateSchedule(bad)).toThrow(new RegExp(k));
    }
    // Malformed dates.
    for (const field of ['startDate', 'endDate'] as const) {
      const bad = JSON.stringify({
        ...base,
        meets: [{ ...validMeet, [field]: '2026-13-99' }],
      });
      expect(() => validateSchedule(bad)).toThrow(new RegExp(field));
    }
  });

  it('accepts meets with empty or missing location', () => {
    const base = {
      version: 1,
      materialId: 'x',
      season: 'y',
      title: 't',
      meetingDayOfWeek: 'Mon',
      weeks: [],
    };
    const meet = {
      id: 'first',
      name: 'First',
      startDate: '2026-01-10',
      endDate: '2026-01-12',
    };
    // Empty string — common for "to be announced" cases. "TBD" is also
    // legitimate but it's just a regular non-empty string.
    const empty = validateSchedule(JSON.stringify({ ...base, meets: [{ ...meet, location: '' }] }));
    expect(empty.meets?.[0].location).toBe('');
    // Missing field falls through to ''.
    const missing = validateSchedule(JSON.stringify({ ...base, meets: [meet] }));
    expect(missing.meets?.[0].location).toBe('');
  });

  it('rejects meets where endDate precedes startDate', () => {
    const bad = JSON.stringify({
      version: 1,
      materialId: 'x',
      season: 'y',
      title: 't',
      meetingDayOfWeek: 'Mon',
      weeks: [],
      meets: [
        {
          id: 'first',
          name: 'First',
          startDate: '2026-01-12',
          endDate: '2026-01-10',
          location: 'X',
        },
      ],
    });
    expect(() => validateSchedule(bad)).toThrow(/endDate/);
  });

  it('rejects meets with duplicate ids', () => {
    const meet = {
      name: 'First',
      startDate: '2026-01-10',
      endDate: '2026-01-12',
      location: 'X',
    };
    const bad = JSON.stringify({
      version: 1,
      materialId: 'x',
      season: 'y',
      title: 't',
      meetingDayOfWeek: 'Mon',
      weeks: [],
      meets: [
        { id: 'first', ...meet },
        { id: 'first', ...meet },
      ],
    });
    expect(() => validateSchedule(bad)).toThrow(/duplicated/);
  });
});

describe('migrateSchedule', () => {
  it('turns a v1 non-review week into a single-block v2 week', () => {
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

describe('validateSchedule v2', () => {
  it('accepts v2 wire form with a single block and returns v2 shape', () => {
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
    expect(out.version).toBe(2);
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

  it('rejects a non-review v2 week with zero blocks', () => {
    const bad = {
      ...V1_SCHEDULE,
      version: 2,
      weeks: [{ date: '2025-09-08', isReview: false, blocks: [] }],
    };
    expect(() => validateSchedule(JSON.stringify(bad))).toThrow(ScheduleValidationError);
  });

  it('returns v2 shape when parsing v1 payload', () => {
    const out = validateSchedule(JSON.stringify(V1_SCHEDULE));
    expect(out.version).toBe(2);
    expect(out.weeks[0]!.blocks[0]!.passage.chapter).toBe(1);
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
            {
              passage: V1_SCHEDULE.weeks[0]!.passage,
              verses: { club150: [], club300: [] },
            },
            {
              passage: V1_SCHEDULE.weeks[0]!.passage,
              verses: { club150: [], club300: [] },
            },
          ],
        },
      ],
    });
    expect(() => downgradeScheduleToV1WireFormat(v2)).toThrow(ScheduleValidationError);
  });
});
