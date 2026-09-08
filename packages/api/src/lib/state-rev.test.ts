import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { graduatedVerses } from '../db/schema.js';
import { seedUserWithFixture } from '../test-fixtures.js';
import { type TestApp, createTestApp, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-cor';

async function enroll(test: TestApp, email: string): Promise<{ cookie: string; userId: string }> {
  const { cookie, userId } = await signUpTestUser(test, email);
  seedUserWithFixture({ db: test.db, userId, materialId: MATERIAL_ID, createUser: false });
  return { cookie, userId };
}

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

async function postEvents(test: TestApp, cookie: string, events: unknown[]): Promise<void> {
  const res = await test.app.request(`/api/sync/${MATERIAL_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(200);
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
    const { cookie } = await enroll(test, 'rev@example.com');

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

  it('moves when a review event is applied', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'rev-event@example.com');

    const before = await stateRevFromState(test, cookie);
    await postEvents(test, cookie, [
      {
        clientEventId: randomUUID(),
        timestampSecs: 1_700_000_000,
        snapshotVersion: 1,
        cardId: 0,
        grade: 3,
      },
    ]);
    expect(await stateRevFromState(test, cookie)).not.toBe(before);
  });

  it('moves when a graduation row is deleted out-of-band', async () => {
    // The #126 repair shape: rows removed directly in SQL, no API write.
    // The client's cached rev must stop matching so it refetches.
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await enroll(test, 'rev-repair@example.com');

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
});
