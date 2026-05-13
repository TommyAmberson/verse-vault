import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { userYearSettings } from '../db/schema.js';
import { createTestApp, enrollViaApi, signUpTestUser } from '../test-utils.js';

const MATERIAL_ID = 'nkjv-cor';

type TierScope = 'off' | 'up150' | 'up300' | 'all';
type ChapterListScope = 'off' | 'up150' | 'up300';
type ClubStatus = 'active' | 'maintenance' | 'paused';

interface YearsResponse {
  years: Array<{
    materialId: string;
    title: string;
    description: string;
    enrolled: boolean;
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

  it('lists every catalog year with the enrolled one marked', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const res = await test.app.request('/api/years', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as YearsResponse;
    // Every catalog material is listed.
    expect(body.years.length).toBeGreaterThanOrEqual(8);
    const enrolledYear = body.years.find((y) => y.materialId === MATERIAL_ID);
    expect(enrolledYear).toBeDefined();
    expect(enrolledYear!.enrolled).toBe(true);
    // The other listings show enrolled=false with zero-count chips.
    const unenrolled = body.years.find((y) => y.materialId !== MATERIAL_ID);
    expect(unenrolled).toBeDefined();
    expect(unenrolled!.enrolled).toBe(false);
    expect(unenrolled!.clubs['150'].cardCount).toBe(0);
  });

  it('returns default scopes that derive Active per tier when enrolled', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const res = await test.app.request('/api/years', { headers: { cookie } });
    const body = (await res.json()) as YearsResponse;
    const year = body.years.find((y) => y.materialId === MATERIAL_ID)!;
    expect(year.settings).toEqual({
      headings: true,
      ftv: true,
      newScope: 'all',
      reviewScope: 'all',
      clubCardScope: 'all',
      chapterListScope: 'up300',
      lessonBatchSize: 3,
    });
    for (const tier of ['150', '300', 'full'] as const) {
      expect(year.clubs[tier].status).toBe('active');
    }
  });

  it('derives Maintenance status from scope settings', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const res = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ newScope: 'up150', reviewScope: 'up300' }),
    });
    expect(res.status).toBe(200);

    const get = await test.app.request('/api/years', { headers: { cookie } });
    const body = (await get.json()) as YearsResponse;
    const clubs = body.years.find((y) => y.materialId === MATERIAL_ID)!.clubs;
    expect(clubs['150'].status).toBe('active');
    expect(clubs['300'].status).toBe('maintenance');
    expect(clubs.full.status).toBe('paused');
  });

  it('auto-enrolls when a scope bumps above Off', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');

    // No enrollment yet — POST a scope change directly.
    const res = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ newScope: 'up150', reviewScope: 'all' }),
    });
    expect(res.status).toBe(200);

    const get = await test.app.request('/api/years', { headers: { cookie } });
    const body = (await get.json()) as YearsResponse;
    const year = body.years.find((y) => y.materialId === MATERIAL_ID)!;
    expect(year.enrolled).toBe(true);
    // Card counts are non-zero now that the engine could build.
    expect(year.clubs['150'].cardCount + year.clubs['300'].cardCount).toBeGreaterThan(0);
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

  it('returns 404 when the material is not in the catalog', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');

    const res = await test.app.request(`/api/years/not-a-material/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ headings: false }),
    });
    expect(res.status).toBe(404);
  });
});
