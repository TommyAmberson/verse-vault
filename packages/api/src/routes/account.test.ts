import { eq, getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.js';
import type { AccountExport, ImportSummary } from '../lib/export-format.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { createTestApp, signUpTestUser, type TestApp } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-cor';

async function enroll(test: TestApp, email: string): Promise<{ cookie: string; userId: string }> {
  const { cookie, userId } = await signUpTestUser(test, email);
  seedUserWithFixture({ db: test.db, userId, materialId: MATERIAL_ID, createUser: false });
  return { cookie, userId };
}

describe('account routes', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('requires auth on both endpoints', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;

    const exportRes = await test.app.request('/api/export');
    expect(exportRes.status).toBe(401);

    const importRes = await test.app.request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exportVersion: 1, exportedAt: 0, user: { email: '', name: '' }, materials: [] }),
    });
    expect(importRes.status).toBe(401);
  });

  it('round-trips an account through GET /api/export → POST /api/import', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'src@example.com');

    const exportRes = await test.app.request('/api/export', { headers: { cookie } });
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get('content-disposition') ?? '').toMatch(
      /verse-vault-export-\d{4}-\d{2}-\d{2}\.json/,
    );
    const payload = (await exportRes.json()) as AccountExport;
    expect(payload.exportVersion).toBe(1);
    expect(payload.materials).toHaveLength(1);
    expect(payload.materials[0]!.materialId).toBe(MATERIAL_ID);

    // Fresh user, fresh app — confirms the wire payload is self-contained.
    const test2 = createTestApp();
    const cleanup2 = test2.cleanup;
    try {
      const { cookie: cookie2 } = await signUpTestUser(test2, 'dst@example.com');
      const importRes = await test2.app.request('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: cookie2 },
        body: JSON.stringify(payload),
      });
      expect(importRes.status).toBe(200);
      const summary = (await importRes.json()) as ImportSummary;
      expect(summary.materialsApplied).toBe(1);
      expect(summary.unresolvedCardRefs).toBe(0);

      // dst can now hit GET /api/export and see its own copy.
      const verifyRes = await test2.app.request('/api/export', { headers: { cookie: cookie2 } });
      expect(verifyRes.status).toBe(200);
      const verifyPayload = (await verifyRes.json()) as AccountExport;
      expect(verifyPayload.materials).toHaveLength(1);
      expect(verifyPayload.materials[0]!.materialId).toBe(MATERIAL_ID);
    } finally {
      cleanup2();
    }
  });

  it('rejects malformed JSON with 400', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'me@example.com');
    const res = await test.app.request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects unsupported exportVersion with 400', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'me@example.com');
    const res = await test.app.request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        exportVersion: 999,
        exportedAt: 0,
        user: { email: '', name: '' },
        materials: [],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects oversized payloads with 413', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'me@example.com');

    // 50 MB cap; declare a Content-Length just past it so hono's body-limit
    // rejects without us having to actually build a 50 MB string.
    const res = await test.app.request('/api/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(50 * 1024 * 1024 + 1),
        cookie,
      },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('DELETE /api/account/progress requires auth', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const res = await test.app.request('/api/account/progress', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('wipes progress but keeps the enrolled material', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'reset@example.com');

    const res = await test.app.request('/api/account/progress', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const summary = (await res.json()) as {
      materialsReset: number;
      eventsDeleted: number;
      graduationsDeleted: number;
    };
    expect(summary.materialsReset).toBeGreaterThanOrEqual(0);

    // The deck is still enrolled after a reset.
    const exportRes = await test.app.request('/api/export', { headers: { cookie } });
    const payload = (await exportRes.json()) as {
      materials: { materialId: string; reviewEvents: unknown[] }[];
    };
    expect(payload.materials).toHaveLength(1);
    expect(payload.materials[0]!.reviewEvents).toHaveLength(0);
  });

  it('DELETE /api/account/data requires auth', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const res = await test.app.request('/api/account/data', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('resets the account to new, keeping sign-in and other accounts', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await enroll(test, 'fresh@example.com');
    const other = await enroll(test, 'other@example.com');
    for (const id of [userId, other.userId]) {
      test.db
        .insert(schema.userYearSettings)
        .values({
          userId: id,
          materialId: MATERIAL_ID,
          headingCard: true,
          headingPassageCard: true,
          ftv: true,
          newScope: 'all',
          reviewScope: 'all',
          clubCardScope: 'all',
          chapterListScope: 'all',
          lessonBatchSize: 5,
          updatedAt: 1,
        })
        .run();
      test.db
        .insert(schema.materialSchedules)
        .values({ userId: id, materialId: MATERIAL_ID, scheduleJson: '{}', updatedAt: 1 })
        .run();
    }
    // Progress left for a deck no longer enrolled, as a review waiting on
    // the deck's lock can write after its pass: it would block enrolling
    // that deck again.
    test.db
      .insert(schema.testStates)
      .values({
        userId,
        materialId: 'dropped-deck',
        testKind: 'verse',
        element: '1',
        stability: 1,
        difficulty: 5,
        lastSeenSecs: 1,
        lastBaseSecs: 1,
        lastRootSecs: 1,
      })
      .run();
    const userTables = [
      schema.userMaterials,
      schema.userYearSettings,
      schema.materialSchedules,
      schema.graphSnapshots,
      schema.reviewEvents,
      schema.testStates,
      schema.graduatedVerses,
      schema.graduatedCards,
      schema.pendingEvents,
    ];
    // Every table holding a learner's rows for a material, read from the
    // schema: a table added later fails here until it joins the list above
    // and Reset account clears it.
    const inSchema = (Object.values(schema) as unknown[])
      .filter((table): table is SQLiteTable => is(table, SQLiteTable))
      .filter((table) => {
        const columns = getTableColumns(table);
        return 'userId' in columns && 'materialId' in columns;
      });
    expect(inSchema.map(getTableName).sort()).toEqual(userTables.map(getTableName).sort());
    const rowsFor = (id: string) =>
      userTables.map((table) => test.db.select().from(table).where(eq(table.userId, id)).all().length);
    expect(rowsFor(userId).some((n) => n > 0)).toBe(true);
    const otherBefore = rowsFor(other.userId);

    const res = await test.app.request('/api/account/data', { method: 'DELETE', headers: { cookie } });
    expect(res.status).toBe(200);
    const summary = (await res.json()) as Record<string, number>;
    expect(Object.keys(summary).sort()).toEqual(
      ['eventsDeleted', 'graduationsDeleted', 'materialsReset'].sort(),
    );

    expect(rowsFor(userId).every((n) => n === 0)).toBe(true);
    expect(rowsFor(other.userId)).toEqual(otherBefore);
    // The address, its sign-in methods, and its sessions stay.
    expect(test.db.select().from(schema.user).where(eq(schema.user.id, userId)).all()).toHaveLength(1);
    expect(
      test.db.select().from(schema.account).where(eq(schema.account.userId, userId)).all(),
    ).toHaveLength(1);
    const session = await test.app.request('/api/auth/get-session', { headers: { cookie } });
    expect(await session.json()).not.toBeNull();
  });
});
