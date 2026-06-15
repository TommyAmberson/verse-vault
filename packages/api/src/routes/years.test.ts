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
      headingCard: boolean;
      headingPassageCard: boolean;
      ftv: boolean;
      newScope: TierScope;
      reviewScope: TierScope;
      clubCardScope: TierScope;
      chapterListScope: ChapterListScope;
      lessonBatchSize: number;
      desiredRetention: number;
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
      headingCard: false,
      headingPassageCard: true,
      ftv: true,
      newScope: 'all',
      reviewScope: 'all',
      clubCardScope: 'off',
      chapterListScope: 'up150',
      lessonBatchSize: 3,
      desiredRetention: 0.9,
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
      body: JSON.stringify({ headingCard: true, lessonBatchSize: 5 }),
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
    expect(row?.headingCard).toBe(true);
    expect(row?.headingPassageCard).toBe(true);
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
      body: JSON.stringify({ headingCard: false }),
    });
    expect(res.status).toBe(404);
  });

  it('accepts the new per-club shape and derives legacy scopes', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const res = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        headingCard: false,
        headingPassageCard: true,
        ftv: true,
        clubCardScope: 'off',
        chapterListScope: 'up150',
        memorize: {
          club150: { enabled: true, catchUp: 'calendarCascade' },
          club300: { enabled: true, catchUp: 'sequential' },
          full: { enabled: false, catchUp: 'sequential' },
        },
        review: {
          club150: { enabled: true, desiredRetention: 0.85 },
          club300: { enabled: false, desiredRetention: 0.8 },
          full: { enabled: false, desiredRetention: 0.8 },
        },
        moveToNext: { p150To300: 'fullyMemorized', p300ToFull: 'caughtUp' },
        lessonBatchSize: 1,
      }),
    });
    expect(res.status).toBe(200);

    const get = await test.app.request('/api/years', { headers: { cookie } });
    const body = (await get.json()) as YearsResponse;
    const year = body.years.find((y) => y.materialId === MATERIAL_ID)!;
    // perClubToLegacy collapses memorize.{150,300}.enabled → up300.
    expect(year.settings.newScope).toBe('up300');
    // Only review.club150 enabled → up150.
    expect(year.settings.reviewScope).toBe('up150');
    expect(year.settings.lessonBatchSize).toBe(1);
    // desiredRetention picks club150's value.
    expect(year.settings.desiredRetention).toBe(0.85);
  });

  it('rejects per-club retention out of [0.5, 0.9]', async () => {
    const test = createTestApp();
    cleanup = test.cleanup;
    const { cookie } = await signUpTestUser(test, 'alice@example.com');
    await enrollViaApi(test, cookie, MATERIAL_ID, 150);

    const res = await test.app.request(`/api/years/${MATERIAL_ID}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        headingCard: false,
        headingPassageCard: true,
        ftv: true,
        clubCardScope: 'off',
        chapterListScope: 'up150',
        memorize: {
          club150: { enabled: true, catchUp: 'sequential' },
          club300: { enabled: false, catchUp: 'sequential' },
          full: { enabled: false, catchUp: 'sequential' },
        },
        review: {
          club150: { enabled: true, desiredRetention: 0.95 },
          club300: { enabled: false, desiredRetention: 0.8 },
          full: { enabled: false, desiredRetention: 0.8 },
        },
        moveToNext: { p150To300: 'caughtUp', p300ToFull: 'caughtUp' },
        lessonBatchSize: 1,
      }),
    });
    expect(res.status).toBe(400);
  });
});
