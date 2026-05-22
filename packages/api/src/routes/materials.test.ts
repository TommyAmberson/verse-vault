import { afterEach, describe, expect, it } from 'vitest';

import { userMaterials } from '../db/schema.js';
import { createTestApp, enrollViaApi, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-cor';

interface ListResponse {
  materials: Array<{ id: string; title: string; description: string }>;
}

interface StatusResponse {
  materialId: string;
  clubTier: number | null;
  offlineMode: boolean;
  testCount: number;
}

interface OfflineModeResponse {
  materialId: string;
  offlineMode: boolean;
}

interface RendersResponse {
  renders: Array<{ cardId: number; composed: unknown; fetchedAt: number }>;
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

  it('reports test_states count after enrollment', async () => {
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
    expect(body.testCount).toBeGreaterThan(0);
    expect(body.offlineMode).toBe(false);
  });

  it('toggles offline_mode via PATCH and reflects it in status', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    const on = await test.app.request(`/api/materials/${MATERIAL_ID}/offline-mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ offlineMode: true }),
    });
    expect(on.status).toBe(200);
    expect(((await on.json()) as OfflineModeResponse).offlineMode).toBe(true);

    const status = await test.app.request(`/api/materials/${MATERIAL_ID}/status`, {
      headers: { cookie },
    });
    expect(((await status.json()) as StatusResponse).offlineMode).toBe(true);

    const off = await test.app.request(`/api/materials/${MATERIAL_ID}/offline-mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ offlineMode: false }),
    });
    expect(((await off.json()) as OfflineModeResponse).offlineMode).toBe(false);
  });

  it('rejects offline-mode PATCH for an unenrolled caller with 404', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');

    const res = await test.app.request(`/api/materials/${MATERIAL_ID}/offline-mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ offlineMode: true }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects offline-mode PATCH with a non-boolean body', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    const res = await test.app.request(`/api/materials/${MATERIAL_ID}/offline-mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ offlineMode: 'yes' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects GET /renders when offline_mode is off with 403', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    const res = await test.app.request(`/api/materials/${MATERIAL_ID}/renders`, {
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });

  it('returns every card render once offline_mode is on', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);
    await test.app.request(`/api/materials/${MATERIAL_ID}/offline-mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ offlineMode: true }),
    });

    const res = await test.app.request(`/api/materials/${MATERIAL_ID}/renders`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RendersResponse;
    expect(body.renders.length).toBeGreaterThan(0);
    for (let i = 1; i < body.renders.length; i++) {
      expect(body.renders[i]!.cardId).toBeGreaterThan(body.renders[i - 1]!.cardId);
    }
    // Test app doesn't wire apibibleCache; composed is null on that
    // path. Card-id monotonicity (asserted above) is the load-bearing
    // contract regardless.
    for (const r of body.renders) expect(r.composed).toBeNull();
  });

  it('rejects GET /renders for an unenrolled caller with 404', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');

    const res = await test.app.request(`/api/materials/${MATERIAL_ID}/renders`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
