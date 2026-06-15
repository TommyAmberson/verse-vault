import { afterEach, describe, expect, it } from 'vitest';

import { createTestApp, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-cor';

describe('schedules routes', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('returns 401 without auth', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    expect(
      (await test.app.request(`/api/materials/${MATERIAL_ID}/schedule`)).status,
    ).toBe(401);
  });

  it('returns the bundled default when no user override exists', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    const res = await test.app.request(
      `/api/materials/${MATERIAL_ID}/schedule`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { materialId: string };
    expect(body.materialId).toBe('nkjv-cor');
  });

  it('returns { schedule: null } when no bundled and no user override', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    const res = await test.app.request(`/api/materials/nkjv-john/schedule`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedule: null };
    expect(body.schedule).toBeNull();
  });

  it('PUT persists a customised schedule and a subsequent GET reflects it', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    const custom = {
      version: 1,
      materialId: 'nkjv-cor',
      season: '2025-26',
      title: 'My Edited Schedule',
      meetingDayOfWeek: 'Tue',
      weeks: [],
      meets: [],
    };
    const put = await test.app.request(
      `/api/materials/${MATERIAL_ID}/schedule`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(custom),
      },
    );
    expect(put.status).toBe(200);

    const get = await test.app.request(
      `/api/materials/${MATERIAL_ID}/schedule`,
      { headers: { cookie } },
    );
    expect(get.status).toBe(200);
    const body = (await get.json()) as { title: string };
    expect(body.title).toBe('My Edited Schedule');
  });

  it('PUT 400s when body materialId mismatches URL materialId', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    const wrong = {
      version: 1,
      materialId: 'nkjv-john',
      season: '2025-26',
      title: 'Mismatched',
      meetingDayOfWeek: 'Mon',
      weeks: [],
      meets: [],
    };
    const put = await test.app.request(
      `/api/materials/${MATERIAL_ID}/schedule`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(wrong),
      },
    );
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toMatch(/materialId/);
  });

  it('PUT 400s on malformed payload', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    const put = await test.app.request(
      `/api/materials/${MATERIAL_ID}/schedule`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ not: 'a schedule' }),
      },
    );
    expect(put.status).toBe(400);
  });

  it('DELETE drops the user override and bundled becomes visible again', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    const custom = {
      version: 1,
      materialId: 'nkjv-cor',
      season: '2025-26',
      title: 'My Edited Schedule',
      meetingDayOfWeek: 'Tue',
      weeks: [],
      meets: [],
    };
    await test.app.request(`/api/materials/${MATERIAL_ID}/schedule`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(custom),
    });

    const del = await test.app.request(
      `/api/materials/${MATERIAL_ID}/schedule`,
      { method: 'DELETE', headers: { cookie } },
    );
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { fallbackToBundled: boolean };
    expect(delBody.fallbackToBundled).toBe(true);

    // Subsequent GET should now return the bundled title, not 'My Edited Schedule'.
    const get = await test.app.request(
      `/api/materials/${MATERIAL_ID}/schedule`,
      { headers: { cookie } },
    );
    const body = (await get.json()) as { title: string };
    expect(body.title).not.toBe('My Edited Schedule');
  });

  it('404 on unknown materialId across all methods', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    const get = await test.app.request('/api/materials/nope/schedule', {
      headers: { cookie },
    });
    expect(get.status).toBe(404);
    const put = await test.app.request('/api/materials/nope/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    expect(put.status).toBe(404);
    const del = await test.app.request('/api/materials/nope/schedule', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(404);
  });
});
