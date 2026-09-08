import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { graduatedVerses, reviewEvents } from '../db/schema.js';
import { seedEnrolledUser } from '../test-fixtures.js';
import { type TestApp, createTestApp, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-cor';

async function stateRevFromState(test: TestApp, cookie: string): Promise<string> {
  const res = await test.app.request(`/api/sync/${MATERIAL_ID}/state`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { stateRev: string };
  expect(typeof body.stateRev).toBe('string');
  return body.stateRev;
}

async function stateRevFromYears(test: TestApp, cookie: string): Promise<string | undefined> {
  const res = await test.app.request('/api/years', { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    years: Array<{ materialId: string; enrolled: boolean; stateRev?: string }>;
  };
  return body.years.find((y) => y.materialId === MATERIAL_ID)?.stateRev;
}

async function postEvents(
  test: TestApp,
  cookie: string,
  events: unknown[],
): Promise<{ stateRev?: string }> {
  const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { stateRev?: string };
}

function reviewEvent(cardId = 0, grade = 3) {
  return {
    clientEventId: randomUUID(),
    timestampSecs: 1_700_000_000,
    snapshotVersion: 1,
    cardId,
    grade,
  };
}

describe('stateRev fingerprint', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('is stable across reads and agrees between /state and /years', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await seedEnrolledUser(test, 'rev@example.com', MATERIAL_ID);

    const a = await stateRevFromState(test, cookie);
    const b = await stateRevFromState(test, cookie);
    expect(a).toBe(b);
    expect(await stateRevFromYears(test, cookie)).toBe(a);
  });

  it('is absent on the years row for unenrolled materials', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'norev@example.com');
    expect(await stateRevFromYears(test, cookie)).toBeUndefined();
  });

  it('moves when a review event is applied, and the merge response carries the moved value', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await seedEnrolledUser(test, 'rev-event@example.com', MATERIAL_ID);

    const before = await stateRevFromState(test, cookie);
    const merged = await postEvents(test, cookie, [reviewEvent()]);
    const after = await stateRevFromState(test, cookie);
    expect(after).not.toBe(before);
    // The flush that moved the state stores this beside its cached
    // snapshot — it must be the post-merge value, not a stale one.
    expect(merged.stateRev).toBe(after);
  });

  it('moves when an event is repaired in place', async () => {
    // UPDATE repairs change neither counts nor timestamps; the grade and
    // card id are folded into the events sum precisely so this shape of
    // out-of-band surgery still moves the fingerprint.
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await seedEnrolledUser(test, 'rev-update@example.com', MATERIAL_ID);

    await postEvents(test, cookie, [reviewEvent(0, 3)]);
    const before = await stateRevFromState(test, cookie);

    test.db.update(reviewEvents).set({ grade: 1 }).where(eq(reviewEvents.grade, 3)).run();
    expect(await stateRevFromState(test, cookie)).not.toBe(before);
  });

  it('moves when a graduation row is deleted out-of-band', async () => {
    // The #126 repair shape: rows removed directly in SQL, no API write.
    // The client's cached rev must stop matching so it refetches.
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await seedEnrolledUser(test, 'rev-repair@example.com', MATERIAL_ID);

    await postEvents(test, cookie, [
      {
        kind: 'graduate',
        clientEventId: randomUUID(),
        timestampSecs: 1_700_000_000,
        snapshotVersion: 1,
        verseId: 0,
      },
    ]);
    const graduated = await stateRevFromState(test, cookie);

    test.db.delete(graduatedVerses).run();
    const repaired = await stateRevFromState(test, cookie);
    expect(repaired).not.toBe(graduated);
  });

  it('uses a covering index for the events aggregate', async () => {
    // The fingerprint runs on every /api/years call; without migration
    // 0026's five-column index each call pays a rowid seek per event.
    const test = createTestApp();
    cleanup = test.cleanup;
    const plan = test.db.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN
          SELECT COUNT(*), COALESCE(MAX(timestamp_secs), 0),
                 COALESCE(SUM(timestamp_secs + card_id + grade), 0)
          FROM review_events WHERE user_id = 'u' AND material_id = 'm'`,
    );
    expect(plan.map((r) => r.detail).join(' ')).toContain('COVERING INDEX');
  });
});
