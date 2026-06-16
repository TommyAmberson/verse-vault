import { describe, expect, it } from 'vitest';

import { createTestDb, createTestUser } from '../test-utils.js';
import * as schema from '../db/schema.js';
import {
  ScheduleValidationError,
  loadBundledSchedule,
  loadSchedule,
  validateSchedule,
} from './schedules.js';

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
