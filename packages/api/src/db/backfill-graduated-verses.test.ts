import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDb, createTestUser } from '../test-utils.js';
import { graduatedVerses, testStates } from './schema.js';

// Migration 0024 backfills `graduated_verses` from PhraseFromContext
// evidence (#111). `createTestDb` runs the migration against an empty
// database, so these tests re-apply the migration's SQL after seeding
// pre-migration-shaped rows — same statement, same semantics as the
// deploy-time run against live data.
const MIGRATION_SQL = readFileSync(
  resolve(import.meta.dirname, '../../migrations/0024_backfill_graduated_verses.sql'),
  'utf8',
);

function applyBackfill(dbPath: string): void {
  const sqlite = new Database(dbPath);
  try {
    sqlite.exec(MIGRATION_SQL);
  } finally {
    sqlite.close();
  }
}

// A reviewed row: FSRS-updated stability/difficulty never reproduce
// the exact seed constants (1.0 / 5.0), so any graded test escapes the
// migration's pristine-seed exclusion.
function phraseRow(userId: string, verseId: number, startWord: number, lastSeenSecs: number) {
  return {
    userId,
    materialId: 'nkjv-cor',
    testKind: 'PhraseFromContext',
    element: JSON.stringify({
      kind: 'Phrase',
      verse_id: verseId,
      start_word: startWord,
      end_word: startWord + 3,
    }),
    stability: 5.2,
    difficulty: 4.8,
    lastSeenSecs,
    lastBaseSecs: lastSeenSecs,
    lastRootSecs: lastSeenSecs,
    pendingRelearn: 0,
  };
}

// A pristine enrollment seed: `enrollUser` persists the engine's full
// test-state catalogue as `TestState::new_unseen` rows — stability 1.0,
// difficulty 5.0, all three timestamps at enrollment minus 365 d —
// covering every verse of the material before the first review.
function seedRow(userId: string, verseId: number, startWord: number, enrolledAtSecs: number) {
  return {
    ...phraseRow(userId, verseId, startWord, enrolledAtSecs - 365 * 86_400),
    stability: 1.0,
    difficulty: 5.0,
  };
}

describe('0024_backfill_graduated_verses', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('graduates verses with phrase evidence, earliest sighting as timestamp', () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');

    test.db
      .insert(testStates)
      .values([
        phraseRow('u1', 7, 0, 2_000),
        phraseRow('u1', 7, 4, 1_000),
        phraseRow('u1', 9, 0, 3_000),
      ])
      .run();
    applyBackfill(test.path);

    const rows = test.db.select().from(graduatedVerses).all();
    expect(rows.map((r) => [r.verseId, r.graduatedAtSecs]).sort()).toEqual([
      [7, 1_000],
      [9, 3_000],
    ]);
  });

  it('ignores pristine enrollment seeds, graduates only reviewed verses', () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');

    const enrolledAt = 1_000_000;
    test.db
      .insert(testStates)
      .values([
        // Full-catalogue seed: verses 1-3 all get pristine rows.
        seedRow('u1', 1, 0, enrolledAt),
        seedRow('u1', 2, 0, enrolledAt),
        seedRow('u1', 3, 0, enrolledAt),
        // Only verse 2 was actually reviewed (its second phrase).
        phraseRow('u1', 2, 4, enrolledAt + 5_000),
      ])
      .run();
    applyBackfill(test.path);

    const rows = test.db.select().from(graduatedVerses).all();
    expect(rows.map((r) => [r.verseId, r.graduatedAtSecs])).toEqual([[2, enrolledAt + 5_000]]);
  });

  it('ignores multi-verse evidence kinds (VerseHeading / VerseClub)', () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');

    // A HeadingPassage recitation writes VerseHeading rows carrying other
    // verses' ids — not proof the user memorised those verses.
    test.db
      .insert(testStates)
      .values({
        ...phraseRow('u1', 12, 0, 1_000),
        testKind: 'VerseHeading',
        element: JSON.stringify({ kind: 'VerseHeadingBinding', verse_id: 12, heading_idx: 0 }),
      })
      .run();
    applyBackfill(test.path);

    expect(test.db.select().from(graduatedVerses).all()).toHaveLength(0);
  });

  it('preserves existing graduation rows and is idempotent', () => {
    const test = createTestDb();
    cleanup = test.cleanup;
    createTestUser(test.db, 'u1');

    // Pre-existing graduation with a real (earlier) timestamp must win
    // over the backfill's derived one.
    test.db
      .insert(graduatedVerses)
      .values({ userId: 'u1', materialId: 'nkjv-cor', verseId: 7, graduatedAtSecs: 500 })
      .run();
    test.db.insert(testStates).values(phraseRow('u1', 7, 0, 2_000)).run();

    applyBackfill(test.path);
    applyBackfill(test.path);

    const rows = test.db.select().from(graduatedVerses).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.graduatedAtSecs).toBe(500);
  });
});
