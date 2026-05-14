import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { reviewEvents, testStates } from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { type TestApp, createTestApp, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-cor';

interface TestStateWire {
  element: unknown;
  test_kind: string;
  stability: number;
  difficulty: number;
  last_seen_secs: number;
  last_base_secs: number;
  last_root_secs: number;
  pending_relearn?: boolean;
}

interface StateResponse {
  snapshot: { version: number; materialData: unknown };
  testStates: TestStateWire[];
  lastEventId: string | null;
}

interface UploadResponse {
  accepted: number;
  duplicates: number;
  testStates: TestStateWire[];
  lastEventId: string | null;
}

async function enroll(test: TestApp, email: string): Promise<{ cookie: string; userId: string }> {
  const { cookie, userId } = await signUpTestUser(test, email);
  seedUserWithFixture({ db: test.db, userId, materialId: MATERIAL_ID, createUser: false });
  return { cookie, userId };
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

interface UploadEvent {
  clientEventId: string;
  timestampSecs: number;
  snapshotVersion: number;
  cardId: number;
  grade: 1 | 2 | 3 | 4;
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
      body: JSON.stringify({ events: [event()] }),
    });
    expect(eventsRes.status).toBe(404);
  });

  it('returns snapshot + seeded test_states for a newly-enrolled user', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/state`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateResponse;
    expect(body.snapshot.version).toBe(1);
    expect(body.snapshot.materialData).toBeTruthy();
    // Enrollment seeds test_states from the freshly-built engine, so a brand
    // new user already has the full seed set even before any review.
    expect(body.testStates.length).toBeGreaterThan(0);
    expect(body.lastEventId).toBeNull();
  });

  it('accepts an event batch and persists merged state', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const e = event();
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [e] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadResponse;
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);
    expect(body.testStates.length).toBeGreaterThan(0);
    expect(body.lastEventId).not.toBeNull();

    const persistedEvents = test.db.select().from(reviewEvents).all();
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0].clientEventId).toBe(e.clientEventId);
    expect(persistedEvents[0].grade).toBe(3);

    const persistedStates = test.db.select().from(testStates).all();
    expect(persistedStates.length).toBeGreaterThan(0);
  });

  it('is idempotent on re-upload of the same client_event_id', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const e = event();
    await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [e] }),
    });

    const afterFirst = test.db.select().from(testStates).all();

    const second = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [e] }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as UploadResponse;
    expect(body.accepted).toBe(0);
    expect(body.duplicates).toBe(1);

    expect(test.db.select().from(reviewEvents).all()).toHaveLength(1);
    const afterSecond = test.db.select().from(testStates).all();
    expect(afterSecond).toEqual(afterFirst);
  });

  it('returns the chronologically latest lastEventId, even for older batches', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const newer = event({ timestampSecs: 2_000_000_000 });
    const older = event({ timestampSecs: 1_000_000_000 });

    const firstRes = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [newer] }),
    });
    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as UploadResponse;
    const newerId = firstBody.lastEventId;
    expect(newerId).not.toBeNull();

    const secondRes = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [older] }),
    });
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as UploadResponse;
    expect(secondBody.lastEventId).toBe(newerId);

    const stateRes = await test.app.request(`/api/sync/${MATERIAL_ID}/state`, {
      headers: { cookie },
    });
    const stateBody = (await stateRes.json()) as StateResponse;
    expect(stateBody.lastEventId).toBe(newerId);
  });

  it('rejects batches larger than MAX_BATCH_SIZE with 413', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const events = Array.from({ length: 501 }, () => event());
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events }),
    });
    expect(res.status).toBe(413);
  });

  it('rejects non-finite or non-integer numeric fields with 400', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const bad = [
      event({ timestampSecs: Number.NaN }),
      event({ timestampSecs: Number.POSITIVE_INFINITY }),
      event({ timestampSecs: 1.5 }),
      event({ timestampSecs: -1 }),
      event({ snapshotVersion: 0 }),
      event({ cardId: 1.5 }),
      event({ grade: 0 as 1 }),
      event({ grade: 5 as 1 }),
    ];
    for (const e of bad) {
      const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ events: [e] }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a stale snapshot version with 409', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [event({ snapshotVersion: 99 })] }),
    });
    expect(res.status).toBe(409);
  });
});
