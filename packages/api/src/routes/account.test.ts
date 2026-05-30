import { afterEach, describe, expect, it } from 'vitest';

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
});
