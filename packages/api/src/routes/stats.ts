import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import type { DB } from '../db/client.js';
import * as schema from '../db/schema.js';
import { type EngineStore, NotEnrolledError } from '../lib/engine.js';
import { requireEnrollment } from '../lib/enrollment.js';
import { isPass } from '../lib/review-log.js';
import { type SessionVariables, getUser, requireAuth } from '../middleware/session.js';

export interface StatsRoutesDeps {
  db: DB;
  engines: EngineStore;
  now?: () => number;
}

/** Stability buckets in days, tuned roughly to "how long until you'd forget it". */
type BucketLabel = 'weak' | 'learning' | 'familiar' | 'strong' | 'mastered';

type StabilityHistogram = Record<BucketLabel, number>;

/** Familiar-threshold passed to the engine's `learned_verse_count`. Same
 *  cutoff the old SQL `versesLearned` used; defined here so the API
 *  keeps one number to twist if the threshold ever moves. */
const STABILITY_FAMILIAR_DAYS = 7;

const EMPTY_HISTOGRAM: StabilityHistogram = {
  weak: 0,
  learning: 0,
  familiar: 0,
  strong: 0,
  mastered: 0,
};

export function statsRoutes(deps: StatsRoutesDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireAuth());

  app.get('/:materialId', async (c) => {
    const user = getUser(c);
    const materialId = c.req.param('materialId');
    try {
      requireEnrollment(deps.db, { userId: user.id, materialId });
    } catch (err) {
      if (err instanceof NotEnrolledError) return c.json({ error: 'Not enrolled' }, 404);
      throw err;
    }

    const events = deps.db
      .select({ grade: schema.reviewEvents.grade })
      .from(schema.reviewEvents)
      .where(
        and(
          eq(schema.reviewEvents.userId, user.id),
          eq(schema.reviewEvents.materialId, materialId),
        ),
      )
      .all();
    const gradeCount = events.length;
    const passCount = events.reduce((acc, e) => acc + (isPass(e.grade) ? 1 : 0), 0);

    // Every per-verse number now comes from the engine instead of SQL.
    // SQL can't tell a real verse from a HeadingPassage / ChapterClubList
    // pseudo verse, so its counts would include pseudos and inflate the
    // dashboard's "X cards from Y verses" pairing. Engine-side, the
    // CardKind discriminates and the multi-verse cards are excluded
    // consistently across every verse metric.
    let reviewsDueCount = 0;
    let newVerseCount = 0;
    let versesDueCount = 0;
    let versesLearned = 0;
    let cardDistribution: StabilityHistogram = EMPTY_HISTOGRAM;
    let verseDistribution: StabilityHistogram = EMPTY_HISTOGRAM;
    try {
      const loaded = await deps.engines.load({ userId: user.id, materialId });
      const nowSecs = BigInt(now());
      reviewsDueCount = loaded.engine.due_review_count(nowSecs);
      newVerseCount = loaded.engine.new_verse_count();
      versesDueCount = loaded.engine.due_verse_count(nowSecs);
      versesLearned = loaded.engine.learned_verse_count(STABILITY_FAMILIAR_DAYS);
      cardDistribution = JSON.parse(
        loaded.engine.card_stability_histogram(),
      ) as StabilityHistogram;
      verseDistribution = JSON.parse(
        loaded.engine.verse_stability_histogram(),
      ) as StabilityHistogram;
    } catch (err) {
      if (!(err instanceof NotEnrolledError)) throw err;
      // Enrollment was re-checked above; a race where the engine load
      // fails because the snapshot just got pruned still shouldn't 500
      // a stats request — fall back to zero counts and let the next
      // dashboard render pick up the recovered state.
    }

    return c.json({
      materialId,
      versesLearned,
      retentionRate: gradeCount > 0 ? passCount / gradeCount : null,
      totalGrades: gradeCount,
      cardDistribution,
      verseDistribution,
      reviewsDueCount,
      newVerseCount,
      versesDueCount,
    });
  });

  return app;
}
