import { afterEach, describe, expect, it } from 'vitest';

import { cardStates, edgeStates, reviewEvents } from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { type TestApp, createTestApp, signUpTestUser } from '../test-utils.js';

interface StartResponse {
  sessionId: string;
  card: { shown: number[]; hidden: number[]; is_reading: boolean } | null;
  done: boolean;
}

interface ReviewResponse extends StartResponse {
  outcome: { edge_updates: Array<{ edge_id: number }>; redrills_inserted: number };
}

const MATERIAL_ID = 'nkjv-1cor';

async function startEnrolledSession(test: TestApp): Promise<{ cookie: string; userId: string; start: StartResponse }> {
  const { cookie, userId } = await signUpTestUser(test, 'alice@example.com');
  seedUserWithFixture({ db: test.db, userId, materialId: MATERIAL_ID, createUser: false });
  const startRes = await test.app.request('/api/sessions/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      materialId: MATERIAL_ID,
      newVerses: [{ verse_ref: 0, verse_phrases: [2, 3, 4] }],
    }),
  });
  expect(startRes.status).toBe(200);
  return { cookie, userId, start: (await startRes.json()) as StartResponse };
}

describe('session routes', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('requires auth', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const res = await test.app.request('/api/sessions/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ materialId: MATERIAL_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('runs a full session: start → review → done', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId, start } = await startEnrolledSession(test);
    expect(start.done).toBe(false);
    expect(start.card).not.toBeNull();
    expect(start.sessionId).toBeTruthy();

    const sessionId = start.sessionId;
    let card = start.card!;
    let reviews = 0;
    while (card) {
      const grades = card.is_reading
        ? []
        : card.hidden.map((node_id) => ({ node_id, grade: 3 }));
      const res = await test.app.request(`/api/sessions/${sessionId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ grades }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ReviewResponse;
      reviews += 1;
      if (body.done) {
        card = null as unknown as typeof card;
        break;
      }
      card = body.card!;
      expect(card).not.toBeNull();
      if (reviews > 30) throw new Error('loop guard');
    }

    expect(reviews).toBeGreaterThan(0);

    const nextRes = await test.app.request(`/api/sessions/${sessionId}/next`, {
      headers: { cookie },
    });
    expect(nextRes.status).toBe(404);

    // Progressive-reveal "reading" cards are skipped by the event log so
    // the sync replay path stays deterministic — we get one event per drill.
    const loggedEvents = test.db.select().from(reviewEvents).all();
    expect(loggedEvents.length).toBeGreaterThan(0);
    expect(loggedEvents.length).toBeLessThanOrEqual(reviews);
    expect(loggedEvents.every((e) => e.userId === userId)).toBe(true);

    const persistedEdges = test.db.select().from(edgeStates).all();
    expect(persistedEdges.length).toBeGreaterThan(0);

    const persistedCards = test.db.select().from(cardStates).all();
    expect(persistedCards.length).toBeGreaterThan(0);
    expect(persistedCards.some((c) => c.state === 'review')).toBe(true);
  });

  it('rejects access to other users sessions', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { start } = await startEnrolledSession(test);

    const res = await test.app.request(`/api/sessions/${start.sessionId}/next`);
    expect(res.status).toBe(401);
  });

  it('aborts a session', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, start } = await startEnrolledSession(test);

    const abortRes = await test.app.request(`/api/sessions/${start.sessionId}/abort`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(abortRes.status).toBe(200);

    const nextRes = await test.app.request(`/api/sessions/${start.sessionId}/next`, {
      headers: { cookie },
    });
    expect(nextRes.status).toBe(404);
  });
});
