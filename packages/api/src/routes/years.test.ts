import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { userClubStatus, userYearSettings } from '../db/schema.js';
import { createTestApp, enrollViaApi, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-1cor';

interface YearsResponse {
  years: Array<{
    materialId: string;
    settings: {
      headings: boolean;
      ftv: boolean;
      citation: boolean;
      lessonBatchSize: number;
    };
    clubs: Record<
      '150' | '300',
      { status: 'active' | 'maintenance' | 'paused'; cardCount: number }
    >;
    untaggedCardCount: number;
  }>;
}

describe('years routes', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('requires auth on every endpoint', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;

    expect((await test.app.request('/api/years')).status).toBe(401);
    expect(
      (
        await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await test.app.request(`/api/years/${MATERIAL_ID}/clubs/150/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' }),
        })
      ).status,
    ).toBe(401);
  });

  it('lists enrolled years with default settings and auto-active clubs', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const res = await test.app.request('/api/years', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearsResponse;
    expect(body.years).toHaveLength(1);
    const year = body.years[0];
    expect(year.materialId).toBe(MATERIAL_ID);
    expect(year.settings).toEqual({
      headings: true,
      ftv: true,
      citation: true,
      lessonBatchSize: 3,
    });
    // First visit auto-creates an active row for any tier that has
    // cards in the material. Empty tiers stay paused.
    for (const tier of ['150', '300'] as const) {
      const club = year.clubs[tier];
      if (club.cardCount > 0) {
        expect(club.status).toBe('active');
      } else {
        expect(club.status).toBe('paused');
      }
    }
    // Sanity check: at least one tier has cards in the shipped material.
    expect(year.clubs['150'].cardCount + year.clubs['300'].cardCount).toBeGreaterThan(0);
  });

  it('persists the auto-active club row on first GET', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    await test.app.request('/api/years', { headers: { cookie } });
    const row = test.db
      .select()
      .from(userClubStatus)
      .where(
        and(
          eq(userClubStatus.userId, userId),
          eq(userClubStatus.materialId, MATERIAL_ID),
          eq(userClubStatus.clubTier, '150'),
        ),
      )
      .get();
    expect(row?.status).toBe('active');
  });

  it('persists settings updates and accepts partial bodies', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const res = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ headings: false, lessonBatchSize: 5 }),
    });
    expect(res.status).toBe(200);

    const row = test.db
      .select()
      .from(userYearSettings)
      .where(
        and(
          eq(userYearSettings.userId, userId),
          eq(userYearSettings.materialId, MATERIAL_ID),
        ),
      )
      .get();
    expect(row?.headings).toBe(false);
    expect(row?.ftv).toBe(true);
    expect(row?.citation).toBe(true);
    expect(row?.lessonBatchSize).toBe(5);
  });

  it('rejects invalid batch sizes', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const tooSmall = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ lessonBatchSize: 0 }),
    });
    expect(tooSmall.status).toBe(400);

    const tooBig = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ lessonBatchSize: 999 }),
    });
    expect(tooBig.status).toBe(400);
  });

  it('persists club status updates and rejects bad inputs', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie, userId } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const ok = await test.app.request(`/api/years/${MATERIAL_ID}/clubs/150/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ status: 'maintenance' }),
    });
    expect(ok.status).toBe(200);
    const row = test.db
      .select()
      .from(userClubStatus)
      .where(
        and(
          eq(userClubStatus.userId, userId),
          eq(userClubStatus.materialId, MATERIAL_ID),
          eq(userClubStatus.clubTier, '150'),
        ),
      )
      .get();
    expect(row?.status).toBe('maintenance');

    const badStatus = await test.app.request(
      `/api/years/${MATERIAL_ID}/clubs/150/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ status: 'on-fire' }),
      },
    );
    expect(badStatus.status).toBe(400);

    const badTier = await test.app.request(
      `/api/years/${MATERIAL_ID}/clubs/999/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(badTier.status).toBe(400);
  });

  it('returns 404 when the user is not enrolled', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');

    const settings = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ headings: false }),
    });
    expect(settings.status).toBe(404);

    const status = await test.app.request(
      `/api/years/${MATERIAL_ID}/clubs/150/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ status: 'active' }),
      },
    );
    expect(status.status).toBe(404);
  });
});
