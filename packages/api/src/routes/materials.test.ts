import { afterEach, describe, expect, it } from 'vitest';

import { userMaterials } from '../db/schema.js';
import { createTestApp, enrollViaApi, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-1cor';

interface ListResponse {
  materials: Array<{ id: string; title: string; description: string }>;
}

interface StatusResponse {
  materialId: string;
  clubTier: number | null;
  cardCounts: { new: number; learning: number; review: number; relearning: number };
  nextDueSecs: number | null;
}

describe('materials routes', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('requires auth on every endpoint', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;

    expect((await test.app.request('/api/materials')).status).toBe(401);
    expect(
      (
        await test.app.request('/api/materials/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ materialId: MATERIAL_ID }),
        })
      ).status,
    ).toBe(401);
    expect((await test.app.request(`/api/materials/${MATERIAL_ID}/status`)).status).toBe(401);
  });

  it('lists the manifest', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');

    const res = await test.app.request('/api/materials', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.materials.length).toBeGreaterThan(0);
    expect(body.materials.some((m) => m.id === MATERIAL_ID)).toBe(true);
  });

  it('enrolls a user and rejects a second enrollment with 409', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'alice@example.com');

    const res = await test.app.request('/api/materials/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ materialId: MATERIAL_ID, clubTier: 150 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { materialId: string; snapshotId: string; version: number };
    expect(body.materialId).toBe(MATERIAL_ID);
    expect(body.version).toBe(1);

    const persisted = test.db
      .select()
      .from(userMaterials)
      .all()
      .find((r) => r.userId === userId && r.materialId === MATERIAL_ID);
    expect(persisted?.clubTier).toBe(150);

    const second = await test.app.request('/api/materials/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ materialId: MATERIAL_ID }),
    });
    expect(second.status).toBe(409);
  });

  it('rejects enrollment in an unknown material with 404', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');

    const res = await test.app.request('/api/materials/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ materialId: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 status for a caller that has not enrolled', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');

    const res = await test.app.request(`/api/materials/${MATERIAL_ID}/status`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('reports card counts after enrollment', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    const res = await test.app.request(`/api/materials/${MATERIAL_ID}/status`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusResponse;
    expect(body.materialId).toBe(MATERIAL_ID);
    expect(body.cardCounts.new).toBeGreaterThan(0);
    expect(body.cardCounts.review).toBe(0);
    expect(body.nextDueSecs).toBeNull();
  });
});
