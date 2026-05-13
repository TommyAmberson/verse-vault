import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { userYearSettings } from '../db/schema.js';
import { createTestApp, enrollViaApi, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-1cor';

type TierScope = 'off' | 'up150' | 'up300' | 'all';
type ChapterListScope = 'off' | 'up150' | 'up300';
type ClubStatus = 'active' | 'maintenance' | 'paused';

interface YearsResponse {
  years: Array<{
    materialId: string;
    settings: {
      headings: boolean;
      ftv: boolean;
      newScope: TierScope;
      reviewScope: TierScope;
      clubCardScope: TierScope;
      chapterListScope: ChapterListScope;
      lessonBatchSize: number;
    };
    clubs: Record<'150' | '300' | 'full', { status: ClubStatus; cardCount: number }>;
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
  });

  it('lists enrolled years with default scopes that derive Active per tier', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const res = await test.app.request('/api/years', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearsResponse;
    expect(body.years).toHaveLength(1);
    const year = body.years[0];
    expect(year.settings).toEqual({
      headings: true,
      ftv: true,
      newScope: 'all',
      reviewScope: 'all',
      clubCardScope: 'all',
      chapterListScope: 'up300',
      lessonBatchSize: 3,
    });
    // active_scope=all means every tier with cards is Active.
    for (const tier of ['150', '300', 'full'] as const) {
      const club = year.clubs[tier];
      expect(club.status).toBe('active');
    }
  });

  it('derives Maintenance status from scope settings', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    // Active up to 150, Maintenance up to 300.
    const res = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ newScope: 'up150', reviewScope: 'up300' }),
    });
    expect(res.status).toBe(200);

    const get = await test.app.request('/api/years', { headers: { cookie } });
    const body = (await get.json()) as YearsResponse;
    const clubs = body.years[0].clubs;
    expect(clubs['150'].status).toBe('active');
    expect(clubs['300'].status).toBe('maintenance');
    expect(clubs.full.status).toBe('paused');
  });

  it('persists settings and accepts partial bodies', async () => {
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
    expect(row?.lessonBatchSize).toBe(5);
    // Other scopes preserved at their defaults.
    expect(row?.newScope).toBe('all');
    expect(row?.reviewScope).toBe('all');
  });

  it('rejects invalid scope values', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const bad = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ newScope: 'on-fire' }),
    });
    expect(bad.status).toBe(400);

    const badChapter = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      // chapter_list_scope rejects 'all' specifically — Full chapter cards
      // aren't a thing.
      body: JSON.stringify({ chapterListScope: 'all' }),
    });
    expect(badChapter.status).toBe(400);
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
  });
});
