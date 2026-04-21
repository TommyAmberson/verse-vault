import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { cardStates, edgeStates, reviewEvents } from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { type TestApp, createTestApp, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-1cor';

interface EdgeEntry {
  edge_id: number;
  stability: number;
  difficulty: number;
  last_review_secs: number;
}
interface CardEntry {
  card_id: number;
  state: 'new' | 'learning' | 'review' | 'relearning';
  due_r: number | null;
  due_date_secs: number | null;
  priority: number | null;
}
interface StateResponse {
  snapshot: { version: number; graphData: unknown; cardsData: unknown };
  edgeStates: EdgeEntry[];
  cardStates: CardEntry[];
  lastEventId: string | null;
}
interface UploadResponse {
  accepted: number;
  duplicates: number;
  edgeStates: EdgeEntry[];
  cardStates: CardEntry[];
  lastEventId: string | null;
}

async function enroll(
  test: TestApp,
  email: string,
): Promise<{ cookie: string; userId: string }> {
  const { cookie, userId } = await signUpTestUser(test, email);
  seedUserWithFixture({ db: test.db, userId, materialId: MATERIAL_ID, createUser: false });
  return { cookie, userId };
}

describe('sync routes', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('requires auth', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;

    const stateRes = await test.app.request(`/api/sync/${MATERIAL_ID}/state`);
    expect(stateRes.status).toBe(401);

    const eventsRes = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });
    expect(eventsRes.status).toBe(401);
  });

  it('returns 404 when the user is not enrolled', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'nouser@example.com');

    const stateRes = await test.app.request(`/api/sync/${MATERIAL_ID}/state`, {
      headers: { cookie },
    });
    expect(stateRes.status).toBe(404);

    const eventsRes = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        events: [
          {
            clientEventId: randomUUID(),
            timestampSecs: 1_700_000_000,
            snapshotVersion: 1,
            cardId: 0,
            shown: [0],
            hidden: [2],
            grades: [{ node_id: 2, grade: 3 }],
          },
        ],
      }),
    });
    expect(eventsRes.status).toBe(404);
  });

  it('returns snapshot + empty state for a newly-enrolled user', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/state`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateResponse;
    expect(body.snapshot.version).toBe(1);
    expect(body.snapshot.graphData).toBeTruthy();
    expect(body.snapshot.cardsData).toBeTruthy();
    expect(body.edgeStates).toEqual([]);
    expect(body.cardStates).toEqual([]);
    expect(body.lastEventId).toBeNull();
  });

  it('accepts an offline event batch and persists merged state', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const event = {
      clientEventId: randomUUID(),
      timestampSecs: 1_700_000_000,
      snapshotVersion: 1,
      cardId: 0,
      shown: [0],
      hidden: [2, 3, 4],
      grades: [
        { node_id: 2, grade: 3 as const },
        { node_id: 3, grade: 3 as const },
        { node_id: 4, grade: 3 as const },
      ],
    };

    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [event] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadResponse;
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(body.edgeStates.length).toBeGreaterThan(0);
    expect(body.cardStates.length).toBeGreaterThan(0);
    expect(body.lastEventId).not.toBeNull();

    const persistedEvents = test.db.select().from(reviewEvents).all();
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0].clientEventId).toBe(event.clientEventId);

    const persistedEdges = test.db.select().from(edgeStates).all();
    expect(persistedEdges.length).toBeGreaterThan(0);
    const persistedCards = test.db.select().from(cardStates).all();
    expect(persistedCards.length).toBeGreaterThan(0);
  });

  it('is idempotent on re-upload of the same client_event_id', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const event = {
      clientEventId: randomUUID(),
      timestampSecs: 1_700_000_000,
      snapshotVersion: 1,
      cardId: 0,
      shown: [0],
      hidden: [2, 3, 4],
      grades: [
        { node_id: 2, grade: 3 as const },
        { node_id: 3, grade: 3 as const },
        { node_id: 4, grade: 3 as const },
      ],
    };

    await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [event] }),
    });

    const afterFirst = test.db.select().from(edgeStates).all();

    const second = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [event] }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as UploadResponse;
    expect(body.accepted).toBe(0);
    expect(body.duplicates).toBe(1);

    expect(test.db.select().from(reviewEvents).all()).toHaveLength(1);
    // Engine state should be unchanged — no events were re-applied.
    const afterSecond = test.db.select().from(edgeStates).all();
    expect(afterSecond).toEqual(afterFirst);
  });

  it('rejects batches larger than MAX_BATCH_SIZE with 413', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const events = Array.from({ length: 501 }, () => ({
      clientEventId: randomUUID(),
      timestampSecs: 1_700_000_000,
      snapshotVersion: 1,
      cardId: 0,
      shown: [0],
      hidden: [2],
      grades: [{ node_id: 2, grade: 3 as const }],
    }));
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events }),
    });
    expect(res.status).toBe(413);
  });

  it('rejects a stale snapshot version with 409', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        events: [
          {
            clientEventId: randomUUID(),
            timestampSecs: 1_700_000_000,
            snapshotVersion: 99,
            cardId: 0,
            shown: [0],
            hidden: [2],
            grades: [{ node_id: 2, grade: 3 }],
          },
        ],
      }),
    });
    expect(res.status).toBe(409);
  });

  it('reaches the same edge state whether a review is done online or via sync', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;

    const alice = await enroll(test, 'alice@example.com');
    const bob = await enroll(test, 'bob@example.com');

    // Alice: review via live session — drive through reading stages until a
    // drill card produces a logged event.
    const startRes = await test.app.request('/api/sessions/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: alice.cookie },
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
    let loops = 0;
    while (test.db.select().from(reviewEvents).all().length === 0) {
      const grades = card.is_reading
        ? []
        : card.hidden.map((node_id) => ({ node_id, grade: 3 as const }));
      const reviewRes = await test.app.request(`/api/sessions/${start.sessionId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: alice.cookie },
        body: JSON.stringify({ grades }),
      });
      expect(reviewRes.status).toBe(200);
      const body = (await reviewRes.json()) as {
        card: typeof card | null;
        done: boolean;
      };
      if (body.done || !body.card) break;
      card = body.card;
      if (++loops > 20) throw new Error('loop guard: no drill card emitted');
    }

    const aliceEvents = test.db.select().from(reviewEvents).all();
    expect(aliceEvents.length).toBeGreaterThan(0);
    const aliceEvent = aliceEvents[0];

    const uploadRes = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: bob.cookie },
      body: JSON.stringify({
        events: [
          {
            clientEventId: randomUUID(),
            timestampSecs: aliceEvent.timestampSecs,
            snapshotVersion: aliceEvent.snapshotVersion,
            cardId: aliceEvent.cardId,
            shown: JSON.parse(aliceEvent.shown.toString('utf8')),
            hidden: JSON.parse(aliceEvent.hidden.toString('utf8')),
            grades: JSON.parse(aliceEvent.grades.toString('utf8')),
          },
        ],
      }),
    });
    expect(uploadRes.status).toBe(200);

    const aliceEdges = sortEdges(
      test.db
        .select()
        .from(edgeStates)
        .all()
        .filter((e) => e.userId === alice.userId),
    );
    const bobEdges = sortEdges(
      test.db
        .select()
        .from(edgeStates)
        .all()
        .filter((e) => e.userId === bob.userId),
    );
    expect(bobEdges.length).toBe(aliceEdges.length);
    for (let i = 0; i < bobEdges.length; i++) {
      expect(bobEdges[i].edgeId).toBe(aliceEdges[i].edgeId);
      expect(bobEdges[i].stability).toBeCloseTo(aliceEdges[i].stability, 4);
      expect(bobEdges[i].difficulty).toBeCloseTo(aliceEdges[i].difficulty, 4);
      expect(bobEdges[i].lastReviewSecs).toBe(aliceEdges[i].lastReviewSecs);
    }
  });
});

function sortEdges<T extends { edgeId: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.edgeId - b.edgeId);
}
