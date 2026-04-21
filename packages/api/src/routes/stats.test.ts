import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestApp, enrollViaApi, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-1cor';

interface StatsResponse {
  materialId: string;
  versesLearned: number;
  retentionRate: number | null;
  totalGrades: number;
  edgeDistribution: Record<'weak' | 'learning' | 'familiar' | 'strong' | 'mastered', number>;
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

  it('returns baseline zeros after enrollment, no reviews yet', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    const res = await test.app.request(`/api/stats/${MATERIAL_ID}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsResponse;
    expect(body.materialId).toBe(MATERIAL_ID);
    expect(body.versesLearned).toBe(0);
    expect(body.retentionRate).toBeNull();
    expect(body.totalGrades).toBe(0);
    for (const count of Object.values(body.edgeDistribution)) expect(count).toBe(0);
  });

  it('counts Hard (grade 2) as a pass, matching the core scheduler', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    // Upload a synthetic event via sync so we control the exact grades.
    const event = {
      clientEventId: randomUUID(),
      timestampSecs: 1_700_000_000,
      snapshotVersion: 1,
      cardId: 0,
      shown: [0],
      hidden: [2, 3, 4],
      grades: [
        { node_id: 2, grade: 2 as const },
        { node_id: 3, grade: 3 as const },
        { node_id: 4, grade: 4 as const },
      ],
    };
    const uploadRes = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [event] }),
    });
    expect(uploadRes.status).toBe(200);

    const res = await test.app.request(`/api/stats/${MATERIAL_ID}`, { headers: { cookie } });
    const body = (await res.json()) as StatsResponse;
    expect(body.totalGrades).toBe(3);
    // Hard, Good, Easy all count as passes per crates/core/src/types.rs::is_pass.
    expect(body.retentionRate).toBe(1);
  });

  it('reflects review activity', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID);

    const startRes = await test.app.request('/api/sessions/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        materialId: MATERIAL_ID,
        newVerses: [{ verse_ref: 0, verse_phrases: [2, 3, 4] }],
      }),
    });
    const start = (await startRes.json()) as {
      sessionId: string;
      card: { shown: number[]; hidden: number[]; is_reading: boolean };
    };

    let card = start.card;
    let guard = 0;
    while (card) {
      const grades = card.is_reading
        ? []
        : card.hidden.map((node_id) => ({ node_id, grade: 3 as const }));
      const reviewRes = await test.app.request(`/api/sessions/${start.sessionId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ grades }),
      });
      const body = (await reviewRes.json()) as { done: boolean; card: typeof card | null };
      if (body.done || !body.card) break;
      card = body.card;
      if (++guard > 30) throw new Error('loop guard');
    }

    const res = await test.app.request(`/api/stats/${MATERIAL_ID}`, { headers: { cookie } });
    const body = (await res.json()) as StatsResponse;
    expect(body.totalGrades).toBeGreaterThan(0);
    expect(body.retentionRate).toBe(1); // all grades were 3 = pass
    const edgeTotal = Object.values(body.edgeDistribution).reduce((a, b) => a + b, 0);
    expect(edgeTotal).toBeGreaterThan(0);
  });
});
