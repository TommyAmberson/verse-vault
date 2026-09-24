import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  graduatedCards,
  graduatedVerses,
  pendingEvents,
  reviewEvents,
  testStates,
} from '../db/schema.js';
import { seedEnrolledUser, switchedOffCardId } from '../test-fixtures.js';
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
  graduatedVerseIds: number[];
  graduatedCardIds: number[];
}

interface Disposition {
  index: number;
  clientEventId: string | null;
  disposition: 'applied' | 'duplicate' | 'pending' | 'unusable';
  reasonCode?: string;
  reason?: string;
}

interface UploadResponse {
  accepted: number;
  duplicates: number;
  rebuilt: boolean;
  testStates: TestStateWire[];
  lastEventId: string | null;
  dispositions: Disposition[];
}

async function upload(
  test: TestApp,
  cookie: string,
  events: unknown[],
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: UploadResponse }> {
  const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ events, ...extra }),
  });
  return { status: res.status, body: (await res.json()) as UploadResponse };
}

async function enroll(test: TestApp, email: string): Promise<{ cookie: string; userId: string }> {
  return seedEnrolledUser(test, email, MATERIAL_ID);
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

  it('404s state but takes events as pending when the user is not enrolled', async () => {
    // Reading state that does not exist is a 404. Refusing the upload
    // would strand the work on the device forever, so it is taken and
    // held until the account enrols (FR-018).
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'nouser@example.com');

    const stateRes = await test.app.request(`/api/sync/${MATERIAL_ID}/state`, {
      headers: { cookie },
    });
    expect(stateRes.status).toBe(404);

    const e = event();
    const { status, body } = await upload(test, cookie, [e]);
    expect(status).toBe(200);
    expect(body.accepted).toBe(0);
    expect(body.dispositions).toEqual([
      {
        index: 0,
        clientEventId: e.clientEventId,
        disposition: 'pending',
        reasonCode: 'not-enrolled',
        reason: expect.any(String),
      },
    ]);
    const held = test.db.select().from(pendingEvents).all();
    expect(held.map((r) => [r.userId, r.clientEventId, r.reasonCode])).toEqual([
      [userId, e.clientEventId, 'not-enrolled'],
    ]);
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

    // Both timestamps in the past — the clock-skew guard rejects events
    // more than 24h in the future. We only need strict newer-vs-older
    // ordering, not a specific era.
    const newer = event({ timestampSecs: 1_700_000_000 });
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

  it('applies good events beside ones it cannot apply, and reports each', async () => {
    // The original incident: one batch mixing good reviews with ids the
    // engine cannot resolve. Every good event must land, and nothing
    // unresolvable may reach review_events, where replay would choke.
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await enroll(test, 'unknown-card@example.com');
    let off: number;
    {
      using loaded = await test.engines.load({ userId, materialId: MATERIAL_ID });
      off = switchedOffCardId(loaded.engine, MATERIAL_ID);
    }
    const good = event({ timestampSecs: 1_700_000_000 });
    const unknown = event({ cardId: 999_999_999, timestampSecs: 1_700_000_001 });
    const switchedOff = event({ cardId: off, timestampSecs: 1_700_000_002 });
    const good2 = event({ timestampSecs: 1_700_000_003 });

    const { status, body } = await upload(test, cookie, [good, unknown, switchedOff, good2]);

    expect(status).toBe(200);
    expect(body.accepted).toBe(2);
    expect(body.dispositions).toEqual([
      { index: 0, clientEventId: good.clientEventId, disposition: 'applied' },
      {
        index: 1,
        clientEventId: unknown.clientEventId,
        disposition: 'unusable',
        reasonCode: 'card-unknown',
        reason: expect.stringContaining('999999999'),
      },
      {
        index: 2,
        clientEventId: switchedOff.clientEventId,
        disposition: 'pending',
        reasonCode: 'card-not-emitted',
        reason: expect.stringContaining(String(off)),
      },
      { index: 3, clientEventId: good2.clientEventId, disposition: 'applied' },
    ]);
    const applied = test.db.select().from(reviewEvents).all().map((r) => r.clientEventId).sort();
    expect(applied).toEqual([good.clientEventId, good2.clientEventId].sort());
    const held = test.db.select().from(pendingEvents).all();
    expect(held.map((r) => [r.clientEventId, r.status, r.reasonCode]).sort()).toEqual(
      [
        [switchedOff.clientEventId, 'pending', 'card-not-emitted'],
        [unknown.clientEventId, 'unusable', 'card-unknown'],
      ].sort(),
    );
  });

  it('takes a batch where nothing applies, leaving applied history alone', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'nothing@example.com');
    const events = [event({ cardId: 999_999_999 }), event({ cardId: 999_999_998 })];

    const { status, body } = await upload(test, cookie, events);

    expect(status).toBe(200);
    expect(body.accepted).toBe(0);
    expect(body.dispositions.map((d) => d.disposition)).toEqual(['unusable', 'unusable']);
    expect(test.db.select().from(reviewEvents).all()).toHaveLength(0);
    expect(test.db.select().from(pendingEvents).all()).toHaveLength(2);
  });

  it('reports a re-uploaded pending event as a duplicate and stores it once', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'retry@example.com');
    const e = event({ cardId: 999_999_999 });

    await upload(test, cookie, [e]);
    const { status, body } = await upload(test, cookie, [e]);

    expect(status).toBe(200);
    expect(body.duplicates).toBe(1);
    expect(body.dispositions).toEqual([
      { index: 0, clientEventId: e.clientEventId, disposition: 'duplicate' },
    ]);
    expect(test.db.select().from(pendingEvents).all()).toHaveLength(1);
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

  it('takes malformed events as unusable instead of refusing them', async () => {
    // A client that cannot hand over its junk cannot empty its outbox
    // (SC-002), so the server takes it and records why it is junk.
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');
    const good = event();
    const bad: unknown[] = [
      event({ timestampSecs: Number.NaN }),
      event({ timestampSecs: Number.POSITIVE_INFINITY }),
      event({ timestampSecs: 1.5 }),
      event({ timestampSecs: -1 }),
      event({ snapshotVersion: 0 }),
      event({ cardId: 1.5 }),
      event({ cardId: -3 }),
      event({ grade: 0 as 1 }),
      event({ grade: 5 as 1 }),
      { ...event(), kind: 'teleport' },
      { ...event(), clientEventId: undefined },
      null,
      42,
    ];

    const { status, body } = await upload(test, cookie, [good, ...bad]);

    expect(status).toBe(200);
    expect(body.accepted).toBe(1);
    expect(body.dispositions[0]).toEqual({
      index: 0,
      clientEventId: good.clientEventId,
      disposition: 'applied',
    });
    const rest = body.dispositions.slice(1);
    expect(rest.map((d) => d.index)).toEqual(bad.map((_, i) => i + 1));
    for (const d of rest) {
      expect(d).toMatchObject({ disposition: 'unusable', reasonCode: 'malformed' });
      expect(d.reason).toBeTruthy();
    }
    // Events with no readable id are still reported, by position.
    expect(rest.slice(-3).map((d) => d.clientEventId)).toEqual([null, null, null]);
    expect(test.db.select().from(pendingEvents).all()).toHaveLength(bad.length);
  });

  it('still refuses a body that carries no list of events', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');
    for (const body of ['not json', JSON.stringify({}), JSON.stringify({ events: 'x' })]) {
      const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body,
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

  it('takes events more than 24h in the future as unusable', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const farFuture = Math.floor(Date.now() / 1000) + 25 * 60 * 60;
    const { status, body } = await upload(test, cookie, [event({ timestampSecs: farFuture })]);
    expect(status).toBe(200);
    expect(body.dispositions[0]).toMatchObject({
      disposition: 'unusable',
      reasonCode: 'malformed',
      reason: expect.stringMatching(/future/),
    });
    expect(test.db.select().from(reviewEvents).all()).toHaveLength(0);
  });

  it('accepts a graduate event and writes graduatedVerses', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await enroll(test, 'alice@example.com');

    const grad = {
      kind: 'graduate' as const,
      clientEventId: randomUUID(),
      timestampSecs: 1_700_000_000,
      snapshotVersion: 1,
      verseId: 0,
    };
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [grad] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadResponse;
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);

    const rows = test.db.select().from(graduatedVerses).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].verseId).toBe(0);

    // Re-applying the graduation is a no-op (engine.graduate_verse returns
    // 0 because the verse is already Active). The wire dedup based on
    // clientEventId doesn't catch this — different clientEventId, same
    // semantic outcome — so the server tracks it as a duplicate via the
    // engine return value.
    const grad2 = { ...grad, clientEventId: randomUUID() };
    const res2 = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [grad2] }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as UploadResponse;
    expect(body2.accepted).toBe(0);
    expect(body2.duplicates).toBe(1);

    // GET /state must surface the graduation so the client can re-apply
    // it after a fresh engine build (cards default to New otherwise).
    const stateRes = await test.app.request(`/api/sync/${MATERIAL_ID}/state`, {
      headers: { cookie },
    });
    const stateBody = (await stateRes.json()) as StateResponse;
    expect(stateBody.graduatedVerseIds).toEqual([0]);
  });

  it('accepts a graduateCard event and writes graduatedCards', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await enroll(test, 'alice@example.com');

    // card_id 0 belongs to the first verse's first card; for the wire
    // protocol test the kind doesn't matter — graduate_card flips any
    // New card to Active.
    const grad = {
      kind: 'graduateCard' as const,
      clientEventId: randomUUID(),
      timestampSecs: 1_700_000_000,
      snapshotVersion: 1,
      cardId: 0,
    };
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [grad] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadResponse;
    expect(body.accepted).toBe(1);
    expect(body.duplicates).toBe(0);

    const rows = test.db.select().from(graduatedCards).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].cardId).toBe(0);

    // Re-applying the graduation is a no-op (graduate_card returns
    // false once the card is Active). Same accounting as graduate.
    const grad2 = { ...grad, clientEventId: randomUUID() };
    const res2 = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [grad2] }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as UploadResponse;
    expect(body2.accepted).toBe(0);
    expect(body2.duplicates).toBe(1);

    // /state surfaces graduatedCardIds alongside graduatedVerseIds so
    // a fresh client engine can re-apply both paths.
    const stateRes = await test.app.request(`/api/sync/${MATERIAL_ID}/state`, {
      headers: { cookie },
    });
    const stateBody = (await stateRes.json()) as StateResponse;
    expect(stateBody.graduatedCardIds).toEqual([0]);
  });

  it('triggers a rebuild when an older event arrives after a newer one', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const newer = event({ timestampSecs: 1_700_000_100, grade: 3, cardId: 0 });
    const firstRes = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [newer] }),
    });
    expect(firstRes.status).toBe(200);
    const firstBody = (await firstRes.json()) as UploadResponse;
    expect(firstBody.rebuilt).toBe(false);
    expect(firstBody.accepted).toBe(1);

    // Second batch: same card, earlier timestamp. The server should
    // detect the per-card out-of-order arrival, replay the full log
    // from baseline, and signal rebuilt: true.
    const older = event({ timestampSecs: 1_700_000_000, grade: 1, cardId: 0 });
    const secondRes = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [older] }),
    });
    expect(secondRes.status).toBe(200);
    const secondBody = (await secondRes.json()) as UploadResponse;
    expect(secondBody.rebuilt).toBe(true);
    expect(secondBody.accepted).toBe(1);

    // Both events landed in the audit log.
    expect(test.db.select().from(reviewEvents).all()).toHaveLength(2);
    // Rebuilt testStates were written back.
    expect(test.db.select().from(testStates).all().length).toBeGreaterThan(0);
  });

  it('does not rebuild when events arrive in order', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const e1 = event({ timestampSecs: 1_700_000_000, grade: 3, cardId: 0 });
    const e2 = event({ timestampSecs: 1_700_000_100, grade: 3, cardId: 0 });
    for (const e of [e1, e2]) {
      const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ events: [e] }),
      });
      const body = (await res.json()) as UploadResponse;
      expect(body.rebuilt).toBe(false);
    }
  });

  /** Put 11 applied events on the server, past the stale-merge
   *  threshold of 10, all newer than `STALE_TS`. */
  async function seedNewerHistory(test: TestApp, cookie: string): Promise<void> {
    for (let i = 0; i < 11; i++) {
      const e = event({ timestampSecs: 1_700_001_000 + i, grade: 3, cardId: 0 });
      const { status } = await upload(test, cookie, [e]);
      expect(status).toBe(200);
    }
  }
  const STALE_TS = 1_700_000_000;

  async function getState(test: TestApp, cookie: string) {
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/state`, { headers: { cookie } });
    return (await res.json()) as StateResponse & {
      pendingConfirmation: {
        queuedCount: number;
        serverEventsSince: number;
        oldestQueuedTs: number;
        newestServerTs: number;
      } | null;
    };
  }

  async function confirm(test: TestApp, cookie: string, decision: unknown) {
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ decision }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('takes a stale batch as pending and asks about it', async () => {
    // The question used to be asked about work held only in the browser,
    // so wiping the device before answering lost it. Now the work is
    // on the server before the question is asked (FR-011).
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');
    await seedNewerHistory(test, cookie);

    const stale = event({ timestampSecs: STALE_TS, grade: 1, cardId: 0 });
    const { status, body } = await upload(test, cookie, [stale]);

    expect(status).toBe(200);
    const b = body as UploadResponse & {
      needsConfirm: boolean;
      staleSummary: Record<string, number>;
    };
    expect(b.needsConfirm).toBe(true);
    expect(b.staleSummary).toMatchObject({
      queuedCount: 1,
      serverEventsSince: 11,
      oldestQueuedTs: STALE_TS,
    });
    expect(b.accepted).toBe(0);
    expect(b.dispositions).toEqual([
      {
        index: 0,
        clientEventId: stale.clientEventId,
        disposition: 'pending',
        reasonCode: 'awaiting-confirmation',
        reason: expect.any(String),
      },
    ]);
    expect(test.db.select().from(reviewEvents).all()).toHaveLength(11);
    const held = test.db.select().from(pendingEvents).all();
    expect(held.map((r) => [r.clientEventId, r.status, r.reasonCode])).toEqual([
      [stale.clientEventId, 'pending', 'awaiting-confirmation'],
    ]);
  });

  it('reports an open merge question on GET /state, from any device', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');
    await seedNewerHistory(test, cookie);
    expect((await getState(test, cookie)).pendingConfirmation).toBeNull();

    await upload(test, cookie, [event({ timestampSecs: STALE_TS, grade: 1 })]);

    expect((await getState(test, cookie)).pendingConfirmation).toEqual({
      queuedCount: 1,
      serverEventsSince: 11,
      oldestQueuedTs: STALE_TS,
      newestServerTs: 1_700_001_010,
    });
  });

  it('merges the held batch at its recorded times when confirmed', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');
    await seedNewerHistory(test, cookie);
    const stale = event({ timestampSecs: STALE_TS, grade: 1, cardId: 0 });
    await upload(test, cookie, [stale]);

    const { status, body } = await confirm(test, cookie, 'merge');

    expect(status).toBe(200);
    expect(body).toMatchObject({ accepted: 1, rebuilt: true });
    const row = test.db
      .select()
      .from(reviewEvents)
      .all()
      .find((r) => r.clientEventId === stale.clientEventId);
    expect(row?.timestampSecs).toBe(STALE_TS);
    expect(test.db.select().from(pendingEvents).all()).toHaveLength(0);
    expect((await getState(test, cookie)).pendingConfirmation).toBeNull();
  });

  it('marks the held batch discarded, deleting nothing, when discarded', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');
    await seedNewerHistory(test, cookie);
    await upload(test, cookie, [event({ timestampSecs: STALE_TS, grade: 1 })]);

    const { status, body } = await confirm(test, cookie, 'discard');

    expect(status).toBe(200);
    expect(body).toEqual({ discarded: 1 });
    expect(test.db.select().from(reviewEvents).all()).toHaveLength(11);
    expect(test.db.select().from(pendingEvents).all().map((r) => r.status)).toEqual(['discarded']);
    expect((await getState(test, cookie)).pendingConfirmation).toBeNull();
  });

  it('treats an answer with no open question as a no-op, and rejects nonsense', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    expect(await confirm(test, cookie, 'merge')).toMatchObject({
      status: 200,
      body: { accepted: 0, rebuilt: false },
    });
    expect(await confirm(test, cookie, 'discard')).toEqual({ status: 200, body: { discarded: 0 } });
    expect((await confirm(test, cookie, 'maybe')).status).toBe(400);
  });

  it('merges held events an old client re-sends with confirmMerge', async () => {
    // A client from before this change keeps its outbox on needsConfirm
    // and, on Sync, re-uploads with confirmMerge: true. Those events are
    // already held, so they must be merged, not reported as duplicates.
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');
    await seedNewerHistory(test, cookie);
    const stale = event({ timestampSecs: STALE_TS, grade: 1, cardId: 0 });
    await upload(test, cookie, [stale]);

    const { status, body } = await upload(test, cookie, [stale], { confirmMerge: true });

    expect(status).toBe(200);
    expect(body.accepted).toBe(1);
    expect(body.rebuilt).toBe(true);
    expect(body.dispositions).toEqual([
      { index: 0, clientEventId: stale.clientEventId, disposition: 'applied' },
    ]);
    expect(test.db.select().from(reviewEvents).all()).toHaveLength(12);
    expect(test.db.select().from(pendingEvents).all()).toHaveLength(0);
  });

  it('bypasses the preflight when confirmMerge is true', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    for (let i = 0; i < 11; i++) {
      const e = event({ timestampSecs: 1_700_001_000 + i, grade: 3, cardId: 0 });
      await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ events: [e] }),
      });
    }

    const stale = event({ timestampSecs: 1_700_000_000, grade: 1, cardId: 0 });
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [stale], confirmMerge: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadResponse;
    expect(body.accepted).toBe(1);
    // The stale event triggers the rebuild path (its ts is older than
    // server-applied events for the same card), so rebuilt is true.
    expect(body.rebuilt).toBe(true);

    expect(test.db.select().from(reviewEvents).all()).toHaveLength(12);
  });

  it('does not return needsConfirm under the threshold', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    // Seed 8 server events — under the threshold of 10.
    for (let i = 0; i < 8; i++) {
      const e = event({ timestampSecs: 1_700_001_000 + i, grade: 3, cardId: 0 });
      await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ events: [e] }),
      });
    }

    const stale = event({ timestampSecs: 1_700_000_000, grade: 1, cardId: 0 });
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [stale] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadResponse;
    expect(body.accepted).toBe(1);
    // Under threshold — preflight didn't fire, merge proceeded silently.
    expect(test.db.select().from(reviewEvents).all()).toHaveLength(9);
  });

  it('accepts a mixed batch of review and graduate events', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'alice@example.com');

    const review = event({ timestampSecs: 1_700_000_000 });
    const grad = {
      kind: 'graduate' as const,
      clientEventId: randomUUID(),
      timestampSecs: 1_700_000_001,
      snapshotVersion: 1,
      verseId: 0,
    };
    const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ events: [review, grad] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadResponse;
    expect(body.accepted).toBe(2);
    expect(body.duplicates).toBe(0);

    expect(test.db.select().from(graduatedVerses).all()).toHaveLength(1);
    expect(test.db.select().from(reviewEvents).all()).toHaveLength(1);
  });
});
