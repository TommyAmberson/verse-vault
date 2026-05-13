import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestApp, enrollViaApi, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-cor';

interface StatsResponse {
  materialId: string;
  versesLearned: number;
  retentionRate: number | null;
  totalGrades: number;
  testDistribution: Record<'weak' | 'learning' | 'familiar' | 'strong' | 'mastered', number>;
}

interface UploadEvent {
  clientEventId: string;
  timestampSecs: number;
  snapshotVersion: number;
  cardId: number;
  grade: 1 | 2 | 3 | 4;
}

function event(overrides: Partial<UploadEvent> = {}): UploadEvent {
  return {
    clientEventId: randomUUID(),
    timestampSecs: 1_700_000_000,
    snapshotVersion: 1,
    cardId: 0,
    grade: 3,
    ...overrides,
  };
}

describe('stats routes', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('requires auth', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const res = await test.app.request(`/api/stats/${MATERIAL_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown material', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    const res = await test.app.request('/api/stats/does-not-exist', { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a caller that has not enrolled', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    const res = await test.app.request(`/api/stats/${MATERIAL_ID}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('returns baseline buckets after enrollment, no reviews yet', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    const res = await test.app.request(`/api/stats/${MATERIAL_ID}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsResponse;
    expect(body.materialId).toBe(MATERIAL_ID);
    expect(body.retentionRate).toBeNull();
    expect(body.totalGrades).toBe(0);
    // versesLearned counts verses with at least one familiar+ test; freshly
    // seeded states sit at the engine's default initial stability, which
    // lands in the "weak" bucket — versesLearned should be 0.
    expect(body.versesLearned).toBe(0);
    const total = Object.values(body.testDistribution).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('counts Hard (grade 2) as a pass, matching the core scheduler', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    const events = [event({ grade: 2 }), event({ grade: 3 }), event({ grade: 4 })];
    const uploadRes = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events }),
    });
    expect(uploadRes.status).toBe(200);

    const res = await test.app.request(`/api/stats/${MATERIAL_ID}`, { headers: { cookie } });
    const body = (await res.json()) as StatsResponse;
    expect(body.totalGrades).toBe(3);
    // Hard, Good, Easy all count as passes per crates/core/src/types.rs::is_pass.
    expect(body.retentionRate).toBe(1);
  });

  it('counts Again (grade 1) as a fail', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    const events = [event({ grade: 1 }), event({ grade: 3 })];
    await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events }),
    });

    const res = await test.app.request(`/api/stats/${MATERIAL_ID}`, { headers: { cookie } });
    const body = (await res.json()) as StatsResponse;
    expect(body.totalGrades).toBe(2);
    expect(body.retentionRate).toBe(0.5);
  });
});
