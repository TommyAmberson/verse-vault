import { describe, expect, it } from 'vitest';

import type { PerClubYearSettings } from './year-settings.js';
import { coupleReviewToMemorize } from './year-settings.js';

function perClub(
  memorize: [boolean, boolean, boolean],
  review: [boolean, boolean, boolean],
): PerClubYearSettings {
  return {
    headingCard: false,
    headingPassageCard: true,
    ftv: true,
    clubCardScope: 'off',
    chapterListScope: 'up150',
    memorize: {
      club150: { enabled: memorize[0], catchUp: 'sequential' },
      club300: { enabled: memorize[1], catchUp: 'sequential' },
      full: { enabled: memorize[2], catchUp: 'sequential' },
    },
    review: {
      club150: { enabled: review[0], desiredRetention: 0.8 },
      club300: { enabled: review[1], desiredRetention: 0.7 },
      full: { enabled: review[2], desiredRetention: 0.9 },
    },
    moveToNext: { p150To300: 'fullyMemorized', p300ToFull: 'fullyMemorized' },
    lessonBatchSize: 3,
  };
}

describe('coupleReviewToMemorize', () => {
  // The shape that shipped the "29 to review / Session complete" bug:
  // memorize on, review left at its default off.
  it('enables review for a memorized club', () => {
    const out = coupleReviewToMemorize(perClub([true, false, false], [false, false, false]));

    expect(out.review.club150.enabled).toBe(true);
    expect(out.review.club300.enabled).toBe(false);
    expect(out.review.full.enabled).toBe(false);
  });

  it('leaves a review-only club alone', () => {
    const out = coupleReviewToMemorize(perClub([false, false, false], [false, true, false]));

    expect(out.memorize.club300.enabled).toBe(false);
    expect(out.review.club300.enabled).toBe(true);
  });

  it('keeps every tier paused when nothing is enabled', () => {
    const out = coupleReviewToMemorize(perClub([false, false, false], [false, false, false]));

    expect(Object.values(out.review).every((r) => !r.enabled)).toBe(true);
  });

  it('preserves per-club retention while flipping enabled', () => {
    const out = coupleReviewToMemorize(perClub([true, true, true], [false, false, false]));

    expect(out.review.club150.desiredRetention).toBe(0.8);
    expect(out.review.club300.desiredRetention).toBe(0.7);
    expect(out.review.full.desiredRetention).toBe(0.9);
  });

  it('leaves the rest of the settings untouched', () => {
    const input = perClub([true, false, false], [false, false, false]);
    const out = coupleReviewToMemorize(input);

    expect(out.memorize).toEqual(input.memorize);
    expect(out.chapterListScope).toBe('up150');
    expect(out.lessonBatchSize).toBe(3);
    expect(out.moveToNext).toEqual(input.moveToNext);
  });

  // Read-side coupling is what keeps the settings page's dirty check
  // honest, so a coupled row must be a fixed point.
  it('is idempotent', () => {
    const once = coupleReviewToMemorize(perClub([true, true, false], [false, false, false]));

    expect(coupleReviewToMemorize(once)).toEqual(once);
  });

  it('does not mutate its input', () => {
    const input = perClub([true, false, false], [false, false, false]);
    coupleReviewToMemorize(input);

    expect(input.review.club150.enabled).toBe(false);
  });
});
